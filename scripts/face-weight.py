#!/usr/bin/env python3
"""工具面测量仪器（可复现证据）。

口径与宿主一致：`toolsTokens = ceil(len(JSON.stringify(header.tools)) / 4) + 4`
（见 deepseek-harness `packages/llm/token-meter/src/estimate.ts`）。

数据源全部是**真实日志**：
  · 工具面体量 ← 会话日志最后的 `request/header` 事件（Model-visible ⟺ logged）
  · 使用频率   ← 近 N 天所有会话日志的 `tool/call` 事件

用法：
  python3 scripts/face-weight.py                 # 最新会话 + 近 14 天
  python3 scripts/face-weight.py --days 7
  python3 scripts/face-weight.py --session 879c4ae1

依赖：zstandard（WSL: pip install zstandard）。
"""
import argparse
import collections
import glob
import io
import json
import os
import time

import zstandard as zstd

BASE = os.environ.get('DSH_SESSION_DIR', '/mnt/e/alice/.dsh/sessions')


def jlen(value) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(',', ':')))


def family_of(name: str) -> str:
    return name.split('_')[0] + '_' if '_' in name else name


def read_header(path: str):
    """返回该会话日志中最后一个 request/header 事件的 header.tools。"""
    dctx = zstd.ZstdDecompressor()
    last = None
    with open(path, 'rb') as handle:
        with dctx.stream_reader(handle, read_across_frames=True) as reader:
            for line in io.TextIOWrapper(reader, encoding='utf-8', errors='replace'):
                if '"request/header"' not in line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                if isinstance(obj, dict) and obj.get('type') == 'request/header':
                    last = obj
    if last is None:
        return None
    return (last.get('data') or {}).get('header', {}).get('tools')


def find_name(obj, depth=0):
    """在 tool/call 事件里定位工具名（绑定在 data 的最外层 name 字段）。"""
    if depth > 4:
        return None
    if isinstance(obj, dict):
        name = obj.get('name')
        if isinstance(name, str) and name:
            return name
        for key in ('call', 'tool', 'message', 'content'):
            if key in obj:
                found = find_name(obj[key], depth + 1)
                if found:
                    return found
        for value in obj.values():
            if isinstance(value, (dict, list)):
                found = find_name(value, depth + 1)
                if found:
                    return found
    elif isinstance(obj, list):
        for value in obj:
            found = find_name(value, depth + 1)
            if found:
                return found
    return None


def count_calls(files, days):
    cutoff = time.time() - days * 86400
    calls = collections.Counter()
    dctx = zstd.ZstdDecompressor()
    scanned = 0
    for path in files:
        if os.path.getmtime(path) < cutoff:
            continue
        scanned += 1
        try:
            with open(path, 'rb') as handle:
                with dctx.stream_reader(handle, read_across_frames=True) as reader:
                    for line in io.TextIOWrapper(reader, encoding='utf-8', errors='replace'):
                        if '"tool/call"' not in line:
                            continue
                        try:
                            obj = json.loads(line)
                        except Exception:
                            continue
                        if isinstance(obj, dict) and obj.get('type') == 'tool/call':
                            name = find_name(obj.get('data'))
                            if name:
                                calls[name] += 1
        except Exception as exc:  # 单份日志损坏不影响整体统计
            print('# skip', os.path.basename(path), exc)
    return calls, scanned


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--session', default='')
    parser.add_argument('--days', type=int, default=14)
    args = parser.parse_args()

    files = glob.glob(BASE + '/**/*.jsonl.zstd', recursive=True)
    if not files:
        raise SystemExit('未找到会话日志：' + BASE)
    if args.session:
        pool = [p for p in files if args.session in p]
        if not pool:
            raise SystemExit('未找到匹配会话：' + args.session)
    else:
        pool = files
    header_path = max(pool, key=os.path.getmtime)
    tools = read_header(header_path)
    if not tools:
        raise SystemExit('该会话没有 request/header（还没发起过请求？）')

    total = jlen(tools)
    print('日志: %s' % os.path.relpath(header_path, BASE))
    print('工具面: %d 个工具 · %d 字符 · 约 %d tok（宿主口径）' % (len(tools), total, -(-total // 4) + 4))

    rows = sorted(((jlen(t), t['name']) for t in tools), reverse=True)
    print('\n== 体量最大的 20 个工具 ==')
    for chars, name in rows[:20]:
        print('%-30s %7d 字符 %7.0f tok' % (name, chars, chars / 4))

    families = {}
    for chars, name in rows:
        bucket = families.setdefault(family_of(name), [0, 0])
        bucket[0] += 1
        bucket[1] += chars

    calls, scanned = count_calls(files, args.days)
    print('\n== 族 × 成本 × 近 %d 天调用（%d 份日志有调用记录）=='
          % (args.days, scanned))
    print('%-16s %5s %8s %7s %7s' % ('族', '工具', '字符', 'tok', '调用'))
    order = sorted(families.items(), key=lambda kv: (sum(v for n, v in calls.items()
                   if n.startswith(kv[0]) if kv[0].endswith('_')), -kv[1][1]))
    for family, (count, chars) in order:
        used = sum(v for name, v in calls.items()
                   if name.startswith(family) if family.endswith('_'))
        print('%-16s %5d %8d %7d %7d' % (family, count, chars, chars // 4, used))


if __name__ == '__main__':
    main()
