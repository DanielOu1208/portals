# Offline and native regressions

Run all offline tooling regressions from the repository root:

```sh
python3 -I -B scripts/test-tools.py
```

This runs every `scripts/tests/test_*.py` file in a separate process, up to four
at once (or the CPU count on smaller hosts). Output stays grouped by file and
any failing worker fails the command. `--jobs 1` runs files sequentially.
The original single-process command remains supported:

```sh
python3 -I -B -m unittest discover -s scripts/tests -p 'test_*.py' -v
```

The native Swift harnesses require macOS and Xcode's Swift toolchain:

```sh
(
  for test in scripts/native-*-tests.py; do
    python3 -I -B "$test" || exit $?
  done
)
```

Every launcher still compiles and executes its own harness. The six that import
AgentCore share compiled module/library generations in `.build/native-agent-core`
within the selected `--repository`. Source contents, compiler identity, target,
SDK, compilation flags and compiler environment changes invalidate the cache.
Builds publish atomically under a per-key lock; concurrent launchers reuse one
complete build. Libraries use an `@rpath` install name, not their staging path.
`native-elapsed-tests.py` has no AgentCore dependency and stays independent.

Pass `--fresh-core` to an AgentCore-based launcher to force a rebuild:

```sh
python3 -I -B scripts/native-net-tests.py --fresh-core
```

Older generations stay available for already-linked harnesses. To reclaim disk
space, remove `.build/native-agent-core` only when no native launcher is running.
The cache does not use the Swift package's build database.
