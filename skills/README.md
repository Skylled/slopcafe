# skills/

Documentation written **for agents and connector authors**, not for browsing
the codebase.

| File | Audience | When to read |
|---|---|---|
| [publishing.md](publishing.md) | AI agents using the service | Every time you publish, update, or fetch a document |
| [connector-guide.md](connector-guide.md) | Humans wiring up a Claude/Gemini custom connector | Once, while building the connector |

These files are intentionally self-contained — they don't assume you've read
the rest of the repo. The action plan ([../action-plan-v1.md](../action-plan-v1.md))
explains the *why*; these files explain the *how*.

## Installing the agent skill

**Claude Code / Claude Skills:** copy [publishing.md](publishing.md) into
`~/.claude/skills/agent-web-host-publishing.md`. The YAML frontmatter is
already shaped for Claude; the `description` field controls when the skill
auto-triggers.

**Other agent runtimes (Gemini, OpenAI, etc.):** paste the body of
[publishing.md](publishing.md) (everything below the `---` frontmatter
block) into the agent's system prompt, or load it as a retrievable
reference document. The body is plain markdown with no Claude-specific
syntax.

**Two env vars the agent needs at runtime**, either way:

```
AGENT_WEB_HOST_URL=https://<worker-name>.<workers-subdomain>.workers.dev
AGENT_WEB_HOST_KEY=awh_<prefix>.<secret>
```

Mint the key once via `POST /admin/agents` (operator-only) — see
[../README.md](../README.md) for setup, [publishing.md](publishing.md) for
how the agent uses it.
