> 🇧🇷 [Leia em português](README.pt-BR.md)

# Louro

Free voice dictation on Linux. Press the shortcut, speak as long as you want,
and the text lands wherever your cursor is: terminal, browser, editor, any
form field.

Louro is the parrot: you speak, it repeats.

```
Ctrl+Space  ->  ● a green dot appears, start talking
Ctrl+Space  ->  the dot disappears and the text shows up where you were
```

## Why this exists

Good voice dictation today either charges by the minute or weighs your machine
down.

The existing options fall into two groups. Some send your audio to a paid API
(OpenAI, Google Cloud, Deepgram): they work well, but you watch a meter run
while you talk, and talking freely is the whole point. Others run the model on
your machine (Whisper, Vosk): nothing per use, but you download gigabytes of
model and need a machine with muscle. On a modest computer it is either slow
or wrong.

I wanted both things: pay nothing and speak without a stopwatch.

The way out was sitting on the screen the whole time, inside the browser.
Chrome's speech recognition (the same engine behind Google Docs dictation) is
free, unlimited, and understands Portuguese very well. It is already
installed, it already works, and nobody was using it outside a browser tab.

Louro is the bridge: Chrome becomes a speech engine running hidden, and the
text it recognizes is delivered to whatever application you are using. No API
key, no subscription, no model to download, no GPU.

## The trade-off (read before installing)

Your audio goes to Google's servers. That is how Chrome's recognition works,
the same as when you dictate in Google Docs.

If you need dictation that never leaves your machine, Louro is not for you.
Use [nerd-dictation](https://github.com/ideasman42/nerd-dictation) (Vosk) or
[Whispering](https://github.com/epicenter-md/epicenter) (local Whisper). They
are good and they solve that case.

Louro is for people who want to dictate for free, with no time limit, on any
machine, and are fine with that trade.

## Two engines, you choose

| | Chrome (default) | OpenAI |
|---|---|---|
| Cost | nothing | from US$ 0.003 per minute, paid directly to them |
| API key | not needed | your own |
| Punctuation and capitalization | none | handled for you |
| English jargon accuracy | misses sometimes | much better |
| Audio goes to | Google | OpenAI |

The same sentence, dictated on both:

```
Chrome   the bird flies to the mountain with emotion and gratitude
OpenAI   The bird flew to the mountain, with emotion and gratitude.
```

In daily use, punctuation tends to matter more than raw accuracy: with Chrome
you dictate and then go back to add the commas and periods.

Models available in the panel, from most recommended to oldest:

| Model | Cost/min | Note |
|---|---|---|
| `gpt-transcribe` | US$ 0.0045 | the newest (Jul 2026) and the default here |
| `gpt-4o-mini-transcribe` | US$ 0.003 | the cheapest |
| `gpt-4o-transcribe` | US$ 0.006 | previous generation |
| `whisper-1` | US$ 0.006 | the old one, misses a lot more |

Open the settings with `louro`: you can switch engines, paste your OpenAI key
and pick the language. The key stays on your machine, in a file only you can
read (`~/.config/louro/config.json`, permission 600). The local service is the
one that talks to OpenAI, so the key is never handed to the browser.

A full hour of dictation on the most expensive model costs around US$ 0.36.
For normal use, it disappears into the month.

## Installation

Requires KDE Plasma 6 on Wayland and Google Chrome. Chromium does not work
because it does not ship the key for Google's speech service.

```bash
git clone https://github.com/joaocorrea081/louro.git
cd louro
./install.sh
```

The installer checks the dependencies and tells you what is missing before
touching anything. It does not ask for sudo and installs everything under your
user.

To use a different shortcut:

```bash
./install.sh --atalho "Meta+V"
```

Uninstall:

```bash
./uninstall.sh
```

### Dependencies

| Distro | Command |
|---|---|
| Arch/Manjaro | `sudo pacman -S nodejs python-gobject python-cairo gtk-layer-shell ydotool wl-clipboard curl` |
| Debian/Ubuntu | `sudo apt install nodejs python3-gi python3-cairo gir1.2-gtklayershell-0.1 ydotool wl-clipboard curl` |
| Fedora | `sudo dnf install nodejs python3-gobject python3-cairo gtk-layer-shell ydotool wl-clipboard curl` |

`ydotool` needs the `uinput` module and its daemon running:

```bash
sudo modprobe uinput
echo uinput | sudo tee /etc/modules-load.d/uinput.conf   # for the next boots
systemctl --user enable --now ydotool
```

## Usage

After installing, it starts on login by itself. There is no window to open: it
is the shortcut and the dot.

```bash
louro            # opens the panel, where everything is done
louro status     # are the three pieces up?
louro logs       # what was heard and pasted
louro restart
louro disable    # stop starting on login
```

Typing `louro` alone opens the panel on purpose. This is a program you use
through a shortcut, so memorizing subcommands to manage it would go against
the idea. The panel shows whether everything is up and the latest dictations,
and it is where you find out which words it always gets wrong so you can add
them to the vocabulary.

To change the shortcut after installing: System Settings, Shortcuts, Custom
Shortcuts, "Louro". Or run `install.sh --atalho` again.

## How it works

Three small pieces:

| Piece | File | What it does |
|---|---|---|
| bridge | `bridge.js` | local server (port 8765): coordinates the cycle and pastes the text |
| engine | Chrome | recognizes speech in a hidden window; the page is `engine.html` |
| dot | `overlay.py` | the visual indicator while you speak |
| panel | `config.html` | the settings, served by the bridge itself |

In OpenAI mode, Chrome stops recognizing and only records: the page sends the
audio bytes to the bridge, which uploads them to the API. That is why the key
never needs to exist inside the browser.

```
Ctrl+Space -> POST /toggle -> SSE "start" -> Chrome listens + the dot appears
Ctrl+Space -> POST /toggle -> SSE "stop"  -> the dot disappears immediately
           -> Chrome returns the text via POST /type -> bridge pastes into the focused app
```

### Decisions that are not obvious

Why does the text go through the clipboard instead of being typed?

`ydotool type` drops every character outside ASCII, so "Ação, coração" arrived
as "Ao, corao". And `wtype`, which would solve it, does not work here: KWin
only exposes `zwp_input_method_v1`, not the `zwp_virtual_keyboard_manager_v1`
that wtype requires. What remained was clipboard plus `Shift+Insert`, which
preserves accents and works in GTK, Qt and terminals.

The text is written to both buffers: the clipboard and the primary selection
(what you highlight with the mouse). GTK and Qt fields read `Shift+Insert`
from the clipboard, but several terminals read from the primary. Filling only
one, the terminal pasted the last thing selected instead of the speech.

Accepted side effect: dictated text overwrites both buffers. That also works
as a safety net, because if the paste fails you can just paste by hand.

Why is the dot GTK and not a Chrome window?

It uses `gtk-layer-shell` on the OVERLAY layer with `KeyboardMode.NONE`, so it
sits above everything and never accepts keyboard focus. That is why the
application you are in never loses focus, and the text lands in the right
place. A Chrome window would steal the focus.

Why is Chrome born hidden?

Through a KWin rule called `louro-engine-hidden`, which matches
`wmclass=chrome-127.0.0.1` and catches only Louro's window, not your personal
Chrome. The flags `--disable-backgrounding-occluded-windows`,
`--disable-renderer-backgrounding` and `--disable-background-timer-throttling`
keep Chrome from suspending the page for being minimized. Without them the
recognition dies in the background.

The dot reacts to your voice: the halo grows with the volume reaching the
microphone. That is how you discover the microphone is muted or set to the
wrong device. A still dot while you speak means nothing is being captured, and
if it turns red the audio stopped arriving.

Long dictations: Chrome ends the recognition session on its own after a
stretch of silence. The page reopens and keeps accumulating into the same
text, so speaking with pauses does not cut the sentence.

Microphone permission: granted once in the dedicated profile
(`~/.local/share/louro-chrome`), allowed only for `http://127.0.0.1:8765`.

## When something breaks

```bash
louro status    # did a piece go down?
louro logs      # does the log show a recognition error?
```

| Symptom | Likely cause |
|---|---|
| "no microphone available" | Chrome refuses a sink *monitor* as microphone; check `pactl get-default-source` |
| transcribes but does not paste | `systemctl --user status ydotool` and `lsmod \| grep uinput` |
| pastes the wrong text | something else rewrote the clipboard between speaking and pasting |
| the Chrome window showed up | `busctl --user call org.kde.KWin /KWin org.kde.KWin reconfigure` |
| nothing happens on the shortcut | another program may own the key; change it in System Settings |

To debug the engine, open `http://127.0.0.1:8765` in your normal Chrome. The
page shows the state and the last recognized text.

## Known limits

- KDE Plasma 6 on Wayland only. GNOME, XFCE and X11 would need another way to
  draw the dot and register the global shortcut.
- Official Chrome only. Chromium does not carry the key for the speech
  service.
- It depends on an API that is not a public contract. If Google changes
  Chrome's recognition, it breaks, and there is nothing to do on this side.
- It misses English technical jargon in the middle of Portuguese ("login"
  becomes "alguém"). The Web Speech API accepts no dictionary or context, but
  on the OpenAI engine you can list those words in the panel.

## License

MIT, see [LICENSE](LICENSE).

---

Made by [João Batista](https://joaobatista.tech) · [LinkedIn](https://www.linkedin.com/in/jo%C3%A3o-batista-cj-7934a1113/)
