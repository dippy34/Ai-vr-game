"""
Build every model: `npm run assets` (all) or `npm run assets -- monster props` (some).
Each module in art/blender/ (except common.py) must expose build(). Each build runs in a fresh
Blender process so scripts can't leak state into each other.
"""

import glob
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(HERE, 'blender')


def modules() -> list[str]:
    names = [os.path.splitext(os.path.basename(p))[0] for p in glob.glob(os.path.join(SCRIPTS, '*.py'))]
    return sorted(n for n in names if n != 'common' and not n.startswith('_'))


def main() -> int:
    wanted = sys.argv[1:] or modules()
    failed = []
    for name in wanted:
        print(f'=== {name} ===', flush=True)
        code = (
            f'import sys; sys.path.insert(0, {SCRIPTS!r}); '
            f'import {name}; {name}.build()'
        )
        result = subprocess.run([sys.executable, '-c', code])
        if result.returncode != 0:
            failed.append(name)
    if failed:
        print(f'FAILED: {", ".join(failed)}')
        return 1
    print('all assets built')
    return 0


if __name__ == '__main__':
    sys.exit(main())
