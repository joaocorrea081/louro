#!/usr/bin/env python3
"""Louro — a bolinha de gravacao, unica parte visivel do ditado.

Usa gtk-layer-shell na camada OVERLAY com KeyboardMode.NONE: fica acima de
todas as janelas e nunca aceita foco de teclado. Isso e o que faz o esquema
inteiro funcionar — o terminal jamais perde o foco, entao quando a gravacao
termina o texto vai pro lugar certo sem precisar devolver foco a ninguem.

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

# catppuccin mocha, mesmo tom que a pagina ja usava
COLOR_IDLE = (0.27, 0.28, 0.35)
COLOR_REC = (0.65, 0.89, 0.63)
COLOR_ERR = (0.95, 0.55, 0.66)

state = {"name": "idle", "error": False, "phase": 0.0}


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

        if state["error"]:
            color = COLOR_ERR
        elif recording:
            color = COLOR_REC
        else:
            color = COLOR_IDLE

        # halo pulsante enquanto grava, pra deixar obvio que esta ouvindo
        if recording:
            pulse = (math.sin(state["phase"]) + 1) / 2
            cr.set_source_rgba(*color, 0.18 + 0.22 * pulse)
            cr.arc(cx, cy, (SIZE / 2) - 1 - 4 * (1 - pulse), 0, 2 * math.pi)
            cr.fill()

        cr.set_source_rgba(*color, 0.95)
        cr.arc(cx, cy, SIZE / 2 - 9, 0, 2 * math.pi)
        cr.fill()

        # microfone simples desenhado a mao (sem depender de fonte com emoji)
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


def animate(win):
    if state["name"] == "recording":
        state["phase"] += 0.18
        win.area.queue_draw()
    return True


def apply_state(win, name, error=False):
    state["name"] = name
    state["error"] = error
    if name == "recording":
        win.show_all()
    else:
        # some assim que a gravacao para, antes de o texto ser colado
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
