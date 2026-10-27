# DeepSeek Harness Tool Mapping

Skills speak in actions ("dispatch a subagent", "create a todo", "read a file"). On DeepSeek Harness these resolve to the tools below.

| Action skills request | DeepSeek Harness tool |
| --- | --- |
| Invoke a skill | `skill` with `name: "<skill-name>"` |
| Read a file | `read` |
| Create a new file | `write` |
| Edit a file (targeted replacement) | `edit` |
| Run a shell command | `bash` |
| Search file contents | `grep` |
| Find files by path pattern | `glob` |
| Fetch a URL / read a webpage | `web_fetch` |
| Search the web | `web_search` |
| Dispatch a subagent | `subagent` (fresh context) or `subagent_fork` (inherits this conversation) |
| Message or wait for a subagent / teammate | `send_message`, `wait_agent` |
| Task tracking ("create a todo", "mark complete") | `todo_write` |
| Create or update a long-running goal | `create_goal`, `update_goal` |
| Ask the human a structured question | `ask_user_question` |
| Present a plan for approval (plan mode) | `exit_plan_mode` |

## Invoking a skill

DeepSeek Harness has a native `skill` tool and a session skill catalog. When a
Ryugi instruction says to invoke a skill, call:

```
skill({ name: "brainstorming" })
```

The catalog is produced by the harness; reading a `SKILL.md` with `read` is the
fallback only when the `skill` tool is not available in the current preset. Do
not bypass the `skill` tool when it is present.

## Subagents

`subagent` starts a self-contained child agent; `subagent_fork` inherits this
conversation. Both return their result to this session. If neither tool is
available in the current preset, do the work inline rather than inventing a
`Task` call.

## Task lists

`todo_write` records the session task list. Treat older Ryugi references to
`TodoWrite` as this task-tracking action.

## Instructions file

When a skill mentions "your instructions file", on DeepSeek Harness this is
`AGENTS.md` at the project root (the harness also loads `CLAUDE.md`). The
project's instruction chain takes precedence over Ryugi skills.
