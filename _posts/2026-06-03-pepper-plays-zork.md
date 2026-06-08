---
title: pepper plays zork — text adventure, SVG exploration map, and an IR thermometer datasheet
---

A full session today covering two hardware projects and one significant software feature: giving Pepper a text adventure game to play, with a live-built exploration map shown on the web console.

## Lumina IR-1 product sheet

The MLX90614 IR thermometer firmware from last session got a proper one-page PDF datasheet — generated with fpdf2, dark-to-white redesign for print friendliness, and published as a standalone open-source repo.

A few things that tripped up the PDF generation:

- **fpdf2 core fonts (Helvetica) are latin-1 only** — `—`, `·`, `±`, `²` all raise a `UnicodeEncodeError`. Replace every special character with ASCII equivalents in string literals before passing to `cell()` or `multi_cell()`.
- **`round_rect` doesn't exist in the installed version** — use `rect()` instead.
- **fpdf2 auto page break** — by default the library inserts a new page when content coordinates approach the bottom margin. For a fixed single-page layout, call `pdf.set_auto_page_break(False)` immediately after `add_page()`.

The final layout: white background, orange M5Stack accent bars top and bottom, features column on the left, screen mockup with numbered orange dot callouts on the right, tech specs in a single column below. The callout dots (1–4) sit directly on the screen face rather than connecting lines pointing at text columns — avoids spatial collision with the feature text.

Published at [github.com/reachlin/lumina-ir1](https://github.com/reachlin/lumina-ir1) with firmware, platformio.ini, make_datasheet.py, and the PDF.

## Dropping Minecraft, adding Zork

The Minecraft integration was removed from the brain loop. The core problem: Minecraft is real-time and Mineflayer needs frequent state checks, but an LLM brain on a 10-second heartbeat can't react fast enough to be a useful player. Everything hostile kills Pepper before the next tick fires.

Zork I is a better fit. It's turn-based by design — the game waits for input. The LLM has time to think, narrate, and be characterful.

### Infrastructure

`dfrotz` (the dumb-terminal variant of frotz, no ncurses dependency) ships in the Debian package `frotz`. Added to `docker/brain.Dockerfile`:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends lynx frotz
```

The Zork I z-machine file (`ZORK1.DAT`) is a standard Infocom release — Z-machine format 3, the file extension doesn't matter to dfrotz. It was downloaded from the Infocom archive, verified with `file` (reports "Infocom (Z-machine 3, Release 88, Serial 840726)"), and baked into the Docker image under `/app/games/zork1.dat`.

dfrotz is invoked as `/usr/games/dfrotz -p /app/games/zork1.dat`. The `-p` flag enables plain output mode, suppressing the status bar redraw sequences that would otherwise pollute stdout.

### ZorkSession

`brain/zork.py` wraps dfrotz as a persistent subprocess using `pexpect`. The session stays alive between brain ticks so there's no save/restore overhead on every turn.

```python
class ZorkSession:
    def start(self) -> str:
        self._child = pexpect.spawn(f"{_DFROTZ} -p {self._game_path}", encoding="utf-8", timeout=10)
        self._child.expect(r">")
        intro = self._child.before.strip()
        if Path(self._save_path).exists():
            self._child.sendline("restore")
            self._child.expect(r">")
            self._child.sendline(self._save_path)
            self._child.expect(r">")
        return intro

    def command(self, cmd: str) -> str:
        self._child.sendline(cmd)
        self._child.expect(r">")
        output = self._child.before.strip()
        self._turn += 1
        if self._turn % self.SAVE_EVERY == 0:
            self.save()
        return output
```

Auto-saves every 10 turns to a named Docker volume path (`/app/data/zork_save.qzl`), so Pepper's progress survives container restarts.

Tests mock the entire pexpect subprocess with a `MockChild` class — no real dfrotz in the test suite. The `expect()` call sets `child.before` as a side effect, so the mock needs to replicate that:

```python
class MockChild:
    def __init__(self, responses):
        self._responses = iter(responses)
        self.before = ""
    def expect(self, *args, **kwargs):
        self.before = next(self._responses, "")
        return 0
    def sendline(self, text): pass
    def isalive(self): return self._alive
```

8 tests, all passing, run inside the Docker test container.

### Brain integration

The `zork` tool is wired into `AgentLoop` like any other tool. The blocking pexpect calls run in a thread executor so they don't block the async event loop:

```python
if name == "zork":
    cmd = args["command"].strip()
    if cmd == "start" or not self._zork.is_alive:
        output = await loop.run_in_executor(None, self._zork.start)
    else:
        output = await loop.run_in_executor(None, self._zork.command, cmd)
    await self._brain_log(f">{cmd}\n{output}\nscore:{self._zork.turn} turn:{self._zork.turn}", "zork")
    return {"output": output, "turn": self._zork.turn, "score": self._zork.score}
```

The zork game state is injected into `_build_user` each tick so Pepper always sees the last room description:

```
ZORK I — Turn 14, Score 10/350.
Last game output:
West of House
...
Use the zork() tool to play your next move. Speak a short narration of what you're doing.
```

Stopping the game: when the user clicks "Stop Zork" on the web console, the directive changes to text that doesn't mention "zork". The brain checks this each tick and closes the dfrotz subprocess:

```python
if self._zork.is_alive and "zork" not in directive.lower():
    await loop.run_in_executor(None, self._zork.close)
```

### Provider switch: qwen → OpenAI

qwen2.5:7b via Ollama was already running for the brain. It's too slow (20-30s per tick) and ignores instructions — sending a directive to "use the zork() tool" and the model would call `search()` for weather instead. Switched to `gpt-4o-mini` via the OpenAI API: 1-2s per tick, instruction-following is tight. Pepper immediately narrated her arrival at the white house, opened the mailbox, and started exploring.

## Web console: exploration map

The most interesting piece. Rather than a text game terminal, the web console now shows a live SVG map that builds as Pepper explores.

### Parsing Zork output

Every time the brain calls the zork tool, the output is broadcast to the frontend via the existing `brain_log` WebSocket channel with `level: "zork"`. The frontend parses each message:

- **Room name detection**: first line that is short (< 52 chars), starts with a capital, contains no colon, period, or exclamation mark, and doesn't start with "You", "There", "Your", etc.
- **Direction tracking**: the command line (formatted as `>cmd`) is matched against a direction map covering "go north", "n", "north", "ne", etc.
- **Object extraction**: regex patterns matching "There is a X here.", "You can see a X here.", "A X is lying here." — objects are added to a `Set` per room so duplicates are automatically deduplicated.

Grid coordinates are calculated from movement direction:
- north: (0, -1), south: (0, +1), east: (+1, 0), west: (-1, 0)
- diagonals and up/down get diagonal offsets

Reverse exits are recorded automatically — if Pepper went north from room A to room B, room B gets a south exit back to A.

### SVG rendering

Each room is a `<g>` element containing a rounded `<rect>`, an emoji room icon, the room name in up to two wrapped lines, and a row of emoji object icons below. Connections are `<line>` elements between room centres, deduped with a Set of sorted name pairs.

Room icons are matched by substring of the room name — "West of House" → 🏠, "Forest Path" → 🌲, "Cave" → 🕳️, "Kitchen" → 🍳. Object icons work the same way — "mailbox" → 📬, "lamp" → 🔦, "sword" → ⚔️.

The current room glows with an SVG `feGaussianBlur` filter and has a red dot marking Pepper's position. The `viewBox` auto-adjusts to fit all discovered rooms with padding, so the map scales as exploration grows.

```javascript
function drawMap() {
  // auto-fit viewBox
  const vx = (minX - pad) * CELL_W;
  const vy = (minY - pad) * CELL_H;
  mapSvg.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`);

  // draw edges, then rooms with icons and glow on current
}
```

No library dependency — pure SVG generated from JavaScript. Cytoscape.js would give drag-to-rearrange and force layout but adds 200KB; the hand-rolled SVG is lighter and sufficient.

## What's next

Phase 6 in the plan: build a custom game designed for Pepper rather than retrofitting a 1980s parser adventure. The key upgrade is image generation — DALL-E renders a scene image on first visit to each room, cached to the data volume, displayed on the web console alongside the SVG map. The world state lives in JSON so the brain reads and writes it natively without parsing heuristics.
