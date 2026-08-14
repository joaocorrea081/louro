#!/usr/bin/env python3
"""Louro — a bolinha de gravação, única parte visível do ditado.

Usa gtk-layer-shell na camada OVERLAY com KeyboardMode.NONE: fica acima de
todas as janelas e nunca aceita foco de teclado. Isso é o que faz o esquema
inteiro funcionar: o terminal jamais perde o foco, então quando a gravação
termina o texto vai pro lugar certo sem precisar devolver foco a ninguém.

Aparece enquanto o estado for 'recording' e some em qualquer outro.
"""
import json
import math
import os
import threading
import time
import urllib.error
import urllib.request

import cairo
import gi

gi.require_version("Gtk", "3.0")
gi.require_version("GtkLayerShell", "0.1")
from gi.repository import GLib, Gtk, GtkLayerShell  # noqa: E402

PORT = os.environ.get("LOURO_PORT", "8765")
BASE = f"http://127.0.0.1:{PORT}"
SIZE = 60
MARGIN_BOTTOM = 90

# catppuccin mocha, mesmo tom que a página já usava
COLOR_IDLE = (0.27, 0.28, 0.35)
COLOR_REC = (0.65, 0.89, 0.63)
COLOR_ERR = (0.95, 0.55, 0.66)

# level  = volume que a página acabou de medir (0..1)
# smooth = o mesmo valor amortecido, pra bolinha não tremer entre quadros
# last_level_at = quando chegou o último nível; se parar de chegar, e sinal de
#                 que o microfone não esta entregando áudio (não e só silêncio)
state = {
    "name": "idle",
    "error": False,
    "level": 0.0,
    "smooth": 0.0,
    "last_level_at": 0.0,
}

# tempo gravando sem nenhuma medição chegando antes de acusar problema
SILENCE_ALERT_S = 5.0


class Overlay(Gtk.Window):
    def __init__(self):
        super().__init__(type=Gtk.WindowType.TOPLEVEL)

        GtkLayerShell.init_for_window(self)
        GtkLayerShell.set_layer(self, GtkLayerShell.Layer.OVERLAY)
        GtkLayerShell.set_anchor(self, GtkLayerShell.Edge.BOTTOM, True)
        GtkLayerShell.set_margin(self, GtkLayerShell.Edge.BOTTOM, MARGIN_BOTTOM)
        # o ponto central: sem foco de teclado, a janela abaixo continua ativa
        GtkLayerShell.set_keyboard_mode(self, GtkLayerShell.KeyboardMode.NONE)

        self.set_size_request(SIZE, SIZE)
        self.set_app_paintable(True)
        self.set_decorated(False)

        screen = self.get_screen()
        visual = screen.get_rgba_visual()
        if visual is not None:
            self.set_visual(visual)

        area = Gtk.DrawingArea()
        area.connect("draw", self.on_draw)
        self.add(area)
        self.area = area

    def on_draw(self, _widget, cr):
        # limpa o fundo pra transparente de verdade (janela redonda, sem caixa)
        cr.set_operator(cairo.Operator.SOURCE)
        cr.set_source_rgba(0, 0, 0, 0)
        cr.paint()
        cr.set_operator(cairo.Operator.OVER)

        cx = cy = SIZE / 2
        recording = state["name"] == "recording"
        deaf = recording and not receiving_audio()

        if state["error"] or deaf:
            color = COLOR_ERR
        elif recording:
            color = COLOR_REC
        else:
            color = COLOR_IDLE

        # O halo acompanha o volume da voz: parado significa que nada esta
        # entrando no microfone. Antes ele pulsava sozinho, o que dava a falsa
        # impressao de estar captando mesmo com o microfone mudo.
        if recording:
            level = state["smooth"]
            base = SIZE / 2 - 9
            cr.set_source_rgba(*color, 0.15 + 0.35 * level)
            cr.arc(cx, cy, base + 8 * level, 0, 2 * math.pi)
            cr.fill()

        cr.set_source_rgba(*color, 0.95)
        cr.arc(cx, cy, SIZE / 2 - 9, 0, 2 * math.pi)
        cr.fill()

        # microfone simples desenhado a mão (sem depender de fonte com emoji)
        cr.set_source_rgba(0.12, 0.12, 0.18, 0.9)
        cr.set_line_width(2.2)
        cr.rectangle(cx - 4, cy - 10, 8, 13)
        cr.fill()
        cr.arc(cx, cy + 1, 8, 0, math.pi)
        cr.stroke()
        cr.move_to(cx, cy + 9)
        cr.line_to(cx, cy + 14)
        cr.stroke()
        return False


def receiving_audio():
    """As medições de volume ainda estão chegando da página?"""
    return (time.monotonic() - state["last_level_at"]) < SILENCE_ALERT_S


def animate(win):
    if state["name"] != "recording":
        return True
    # Sobe rapido e desce devagar: acompanha a fala sem tremer entre quadros.
    target = state["level"] if receiving_audio() else 0.0
    rate = 0.5 if target > state["smooth"] else 0.12
    state["smooth"] += (target - state["smooth"]) * rate
    win.area.queue_draw()
    return True


def apply_state(win, name, error=False):
    state["name"] = name
    state["error"] = error
    if name == "recording":
        # começa do zero e da um tempo antes de acusar falta de áudio
        state["level"] = 0.0
        state["smooth"] = 0.0
        state["last_level_at"] = time.monotonic()
        win.show_all()
    else:
        # some assim que a gravação para, antes de o texto ser colado
        win.hide()
    win.area.queue_draw()
    return False


def listen(win):
    """Acompanha o estado do bridge por SSE, reconectando se ele cair."""
    while True:
        try:
            with urllib.request.urlopen(BASE + "/events?client=overlay", timeout=None) as r:
                event = None
                for raw in r:
                    line = raw.decode(errors="replace").strip()
                    if line.startswith("event:"):
                        event = line.split(":", 1)[1].strip()
                    elif line.startswith("data:") and event:
                        payload = line.split(":", 1)[1].strip()
                        if event == "state":
                            try:
                                name = json.loads(payload).get("state", "idle")
                            except json.JSONDecodeError:
                                name = "idle"
                            GLib.idle_add(apply_state, win, name)
                        elif event == "level":
                            try:
                                state["level"] = float(json.loads(payload)["level"])
                                state["last_level_at"] = time.monotonic()
                            except (json.JSONDecodeError, KeyError, TypeError, ValueError):
                                pass
                        elif event == "error":
                            GLib.idle_add(apply_state, win, "recording", True)
                            GLib.timeout_add(1200, apply_state, win, "idle")
                        event = None
        except (urllib.error.URLError, OSError):
            GLib.idle_add(apply_state, win, "idle")
        time.sleep(1.0)


def main():
    win = Overlay()
    win.connect("destroy", Gtk.main_quit)
    threading.Thread(target=listen, args=(win,), daemon=True).start()
    GLib.timeout_add(40, animate, win)
    Gtk.main()


if __name__ == "__main__":
    main()
