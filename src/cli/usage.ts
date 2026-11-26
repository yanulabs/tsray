import { VERSION } from "../version.js";

export const USAGE = `tsray ${VERSION}

Semantic TypeScript/React indexer, MCP stdio server, and offline architecture reporter.

Usage:
  tsray <command> [path] [options]

Commands:
  serve [path]                       Run the MCP stdio server and live report UI
  index [path]                       Build and sync the semantic index once
  export <html|md|dot|mermaid|json> [path]
                                     Export an architecture report
  diff [base-ref] [path]             Compare the working tree against a git ref
  db <path|info|rm|prune> [path]     Inspect or maintain local SQLite databases
  install-mcp [targets...]           Register tsray with MCP clients
  uninstall-mcp [targets...]         Remove tsray from MCP clients
  mcp-status [targets...]            Show MCP registration status
  install-skill [targets...]         Install the tsray agent skill
  uninstall-skill [targets...]       Remove the tsray agent skill
  skill-status [targets...]          Show skill installation status
  version                            Print the version
  help                               Show help

Common options:
  --db <path>                        Single database override (env: TSRAY_DB)
  --tsconfig <path>                  Explicit tsconfig (relative to the target path)
  --workspace                        Force workspace-root discovery
  --allow-errors                     Update indexes despite type errors
  -o, --out <path>                   Write export output to a file
  --json                             Emit machine-readable JSON

serve options:
  --port <n>                         Report UI port (default: 4321, env: TSRAY_PORT)
  --port-range <n>                   Port fallback window (default: 100)
  --strict-port                      Fail if the preferred port is busy
  --host <addr>                      Bind address (default: 127.0.0.1)
  --port-file <path>                 Write the chosen URL and PID to a file
  --open                             Open the report in the default browser
  --no-watch                         Disable file watching
  --log-level <off|error|info>       Stderr verbosity (default: info)

export options:
  --scope <module|file|symbol>       Graph scope for dot/mermaid (default: module)
  --root <symbol-id>                 Root symbol for --scope symbol
  --depth <n>                        Graph BFS depth
  --open                             Open the HTML report after writing

diff options:
  --fail-on <gates>                  cycles,breaking_api,dead_code,untested_hotspots
  --format <md|json>                 Output format (default: json)

db options:
  --summaries                        Target the shared summary database
  --all                              Target working and summary databases
  --dry-run                          Print the deletion plan only
  --force                            Delete even when another process holds the DB

integration options:
  --scope <global|project>           Config scope (default: global)
  --name <name>                      MCP server or skill name (default: tsray)
  --target <target>                  Client target or comma-separated targets
  --args <args>                      MCP server arguments (default: serve)
  --command <path>                   Executable override
  --cwd <path>                       Fixed server working directory
  --config <path>                    Explicit client config file
  --format <format>                  Config format for an explicit path
  --dir <path>                       Explicit skill destination base
  --mode <copy|link>                 Skill install mode (default: copy)
  --project-root <path>              Project scope root (default: cwd)
  --all                              Select every supported client
  --dry-run                          Print planned changes without writing
  --yes                              Skip interactive selection
`;
