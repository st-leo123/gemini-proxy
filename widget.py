import json
import os
import subprocess
import threading
import time
import tkinter as tk
import urllib.request
from PIL import Image, ImageTk, ImageSequence

PROXY_URL = "http://localhost:8080"
TRANSPARENT_KEY = "#010203"

MODELS = [
    ("4 Hydrogen", "gemini-4-hydrogen"),
    ("3.8 Flash", "gemini-3.8-flash"),
    ("3.7 Flash", "gemini-3.7-flash"),
    ("3.5 F-Lite", "gemini-3.5-flash-lite"),
]

MODEL_SHORT = {
    "gemini-4-hydrogen": "4H",
    "gemini-3.8-flash": "3.8F",
    "gemini-3.7-flash": "3.7F",
    "gemini-3.5-flash-lite": "3.5L",
}


class ProxyWidget:
    def __init__(self, root):
        self.root = root
        self.root.title("Gemini Proxy")
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)
        self.root.configure(bg=TRANSPARENT_KEY)
        self.root.attributes("-transparentcolor", TRANSPARENT_KEY)

        self.active_model = "gemini-4-hydrogen"
        self.active_key_index = 1
        self.models_data = {}

        self._press_root_x = 0
        self._press_root_y = 0
        self._win_start_x = 0
        self._win_start_y = 0

        self.expanded = False
        self.gif_frames = []
        self.gif_delays = []
        self.current_frame = 0
        self.anim_job = None
        self.gif_size = (120, 120)

        self.load_gif()

        gw, gh = self.gif_size
        screen_w = self.root.winfo_screenwidth()
        screen_h = self.root.winfo_screenheight()
        init_x = max(0, screen_w - gw - 20)
        init_y = max(0, screen_h - gh - 60)
        self.root.geometry(f"{gw}x{gh}+{init_x}+{init_y}")

        self.setup_ui()
        self.start_animation()

        self.running = True
        threading.Thread(target=self.poll_loop, daemon=True).start()

    def load_gif(self):
        gif_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gifIcon.gif")
        if not os.path.exists(gif_path):
            return
        try:
            gif_img = Image.open(gif_path)
            self.gif_size = gif_img.size
            for frame in ImageSequence.Iterator(gif_img):
                dur = frame.info.get("duration", 100)
                self.gif_delays.append(dur if dur and dur > 0 else 100)

                rgba = frame.convert("RGBA")
                # Composite onto chroma-key background while keeping semi-opaque pixels solid
                bg = Image.new("RGBA", rgba.size, (1, 2, 3, 255))
                bg.paste(rgba, (0, 0), rgba)
                self.gif_frames.append(ImageTk.PhotoImage(bg))
        except Exception as e:
            print("GIF load error:", e)

    def setup_ui(self):
        # Expandable control panel (hidden initially, packs ABOVE the GIF)
        self.panel = tk.Frame(self.root, bg="#181825", bd=1, relief="solid")

        # Header bar
        hdr = tk.Frame(self.panel, bg="#313244")
        hdr.pack(fill=tk.X)
        hdr.bind("<ButtonPress-1>", self.on_press)
        hdr.bind("<B1-Motion>", self.on_drag)

        title_lbl = tk.Label(
            hdr,
            text="⚡ Gemini",
            bg="#313244",
            fg="#cdd6f4",
            font=("Segoe UI", 8, "bold"),
        )
        title_lbl.pack(side=tk.LEFT, padx=4, pady=2)
        title_lbl.bind("<ButtonPress-1>", self.on_press)
        title_lbl.bind("<B1-Motion>", self.on_drag)

        close_btn = tk.Label(
            hdr,
            text="✕",
            bg="#313244",
            fg="#f38ba8",
            font=("Segoe UI", 8, "bold"),
            cursor="hand2",
        )
        close_btn.pack(side=tk.RIGHT, padx=4, pady=2)
        close_btn.bind("<Button-1>", lambda e: self.close())

        min_btn = tk.Label(
            hdr,
            text="—",
            bg="#313244",
            fg="#a6adc8",
            font=("Segoe UI", 8, "bold"),
            cursor="hand2",
        )
        min_btn.pack(side=tk.RIGHT, padx=(0, 2), pady=2)
        min_btn.bind("<Button-1>", lambda e: self.collapse())

        # Body container
        body = tk.Frame(self.panel, bg="#181825", padx=4, pady=4)
        body.pack(fill=tk.BOTH, expand=True)

        # 2-column Keys Grid (top)
        self.keys_frame = tk.Frame(body, bg="#181825")
        self.keys_frame.pack(fill=tk.X, pady=(0, 4))

        # Stacked Models (bottom)
        models_frame = tk.Frame(body, bg="#181825")
        models_frame.pack(fill=tk.X, pady=(0, 3))

        self.model_btns = {}
        for disp, name in MODELS:
            btn = tk.Button(
                models_frame,
                text=disp,
                font=("Segoe UI", 8, "bold"),
                bg="#313244",
                fg="#cdd6f4",
                activebackground="#45475a",
                activeforeground="#ffffff",
                bd=0,
                padx=4,
                pady=2,
                width=11,
                cursor="hand2",
                command=lambda m=name: self.select_model(m),
            )
            btn.pack(fill=tk.X, pady=1)
            self.model_btns[name] = btn

        # Status line
        self.status_lbl = tk.Label(
            body,
            text="Connecting...",
            bg="#181825",
            fg="#a6adc8",
            font=("Segoe UI", 7),
        )
        self.status_lbl.pack(fill=tk.X)

        # Mascot GIF anchored at the bottom of self.root
        self.gif_label = tk.Label(
            self.root,
            bg=TRANSPARENT_KEY,
            cursor="hand2",
            bd=0,
            highlightthickness=0,
        )
        self.gif_label.pack(side=tk.BOTTOM)

        self.gif_label.bind("<ButtonPress-1>", self.on_press)
        self.gif_label.bind("<B1-Motion>", self.on_drag)
        self.gif_label.bind("<ButtonRelease-1>", self.on_release)
        self.gif_label.bind("<Button-3>", lambda e: self.toggle())

    def on_press(self, e):
        self._press_root_x = e.x_root
        self._press_root_y = e.y_root
        self._win_start_x = self.root.winfo_x()
        self._win_start_y = self.root.winfo_y()

    def on_drag(self, e):
        dx = e.x_root - self._press_root_x
        dy = e.y_root - self._press_root_y
        self.root.geometry(f"+{self._win_start_x + dx}+{self._win_start_y + dy}")

    def on_release(self, e):
        if abs(e.x_root - self._press_root_x) < 6 and abs(e.y_root - self._press_root_y) < 6:
            self.toggle()

    def toggle(self):
        if self.expanded:
            self.collapse()
        else:
            self.expand()

    def expand(self):
        if self.expanded:
            return
        self.expanded = True

        # Anchor GIF's current screen position
        gif_x = self.root.winfo_x()
        gif_y = self.root.winfo_y()
        gw, gh = self.gif_size

        self.render_panel()
        self.panel.pack(side=tk.TOP, fill=tk.X, pady=(0, 4))
        self.root.update_idletasks()

        panel_w = max(self.panel.winfo_reqwidth(), 106)
        panel_h = self.panel.winfo_reqheight() + 4
        total_w = max(panel_w, gw)
        total_h = panel_h + gh

        screen_w = self.root.winfo_screenwidth()
        new_x = max(0, min(gif_x - (total_w - gw) // 2, screen_w - total_w))
        new_y = max(0, gif_y - panel_h)

        self.root.geometry(f"{total_w}x{total_h}+{new_x}+{new_y}")

    def collapse(self):
        if not self.expanded:
            return
        self.expanded = False

        # Keep GIF at its exact current screen coordinates
        gif_x = self.gif_label.winfo_rootx()
        gif_y = self.gif_label.winfo_rooty()
        gw, gh = self.gif_size

        self.panel.pack_forget()
        self.root.update_idletasks()
        self.root.geometry(f"{gw}x{gh}+{gif_x}+{gif_y}")

    def resize_while_expanded(self):
        if not self.expanded:
            return
        gif_x = self.gif_label.winfo_rootx()
        gif_y = self.gif_label.winfo_rooty()
        gw, gh = self.gif_size

        self.root.update_idletasks()
        panel_w = max(self.panel.winfo_reqwidth(), 106)
        panel_h = self.panel.winfo_reqheight() + 4
        total_w = max(panel_w, gw)
        total_h = panel_h + gh

        screen_w = self.root.winfo_screenwidth()
        new_x = max(0, min(gif_x - (total_w - gw) // 2, screen_w - total_w))
        new_y = max(0, gif_y - panel_h)

        self.root.geometry(f"{total_w}x{total_h}+{new_x}+{new_y}")

    def start_animation(self):
        if self.gif_frames:
            self.animate_frame()

    def animate_frame(self):
        if not self.gif_frames:
            return
        self.gif_label.config(image=self.gif_frames[self.current_frame])
        delay = self.gif_delays[self.current_frame]
        self.current_frame = (self.current_frame + 1) % len(self.gif_frames)
        self.anim_job = self.root.after(delay, self.animate_frame)

    def select_model(self, m):
        self.active_model = m
        self.send_select({"model": m})

    def select_key(self, idx):
        self.send_select({"model": self.active_model, "keyIndex": idx})

    def reset_key(self, idx):
        self.send_select({"model": self.active_model, "keyIndex": idx, "reset": True})

    def send_select(self, payload):
        def worker():
            try:
                data = json.dumps(payload).encode("utf-8")
                req = urllib.request.Request(
                    f"{PROXY_URL}/select",
                    data=data,
                    headers={"Content-Type": "application/json"},
                )
                with urllib.request.urlopen(req, timeout=2.0) as resp:
                    res = json.loads(resp.read().decode())
                    self.root.after(0, self.update_ui, res)
            except Exception:
                pass

        threading.Thread(target=worker, daemon=True).start()

    def poll_loop(self):
        while self.running:
            try:
                req = urllib.request.Request(
                    f"{PROXY_URL}/status", headers={"User-Agent": "ProxyWidget"}
                )
                with urllib.request.urlopen(req, timeout=2.0) as resp:
                    data = json.loads(resp.read().decode())
                    self.root.after(0, self.update_ui, data)
            except Exception:
                self.root.after(0, self.update_offline)
            time.sleep(2)

    def update_offline(self):
        self.status_lbl.config(text="Proxy Offline", fg="#f38ba8")

    def update_ui(self, data):
        self.active_model = data.get("activeModel", self.active_model)
        self.active_key_index = data.get("activeKeyIndex", self.active_key_index)
        self.models_data = data.get("models", {})
        self.render_panel()
        if self.expanded:
            self.resize_while_expanded()

    def render_panel(self):
        for name, b in self.model_btns.items():
            if name == self.active_model:
                b.config(bg="#89b4fa", fg="#11111b")
            else:
                b.config(bg="#313244", fg="#cdd6f4")

        for w in self.keys_frame.winfo_children():
            w.destroy()

        st_list = self.models_data.get(self.active_model, [])
        if not st_list:
            tk.Label(
                self.keys_frame,
                text="No keys",
                bg="#181825",
                fg="#f38ba8",
                font=("Segoe UI", 8),
            ).pack(pady=2)
        else:
            grid = tk.Frame(self.keys_frame, bg="#181825")
            grid.pack(fill=tk.X)
            grid.columnconfigure(0, weight=1)
            grid.columnconfigure(1, weight=1)

            for i, item in enumerate(st_list):
                if isinstance(item, dict):
                    idx = item.get("index", 1)
                    status = item.get("status", "available")
                    sec_left = item.get("secondsLeft", 0)
                else:
                    idx = item
                    status = "available"
                    sec_left = 0

                is_active = idx == self.active_key_index

                if status == "available":
                    bg, fg, lbl_txt = "#a6e3a1", "#11111b", f"{idx}"
                elif status == "rate_limited":
                    bg, fg = "#f9e2af", "#11111b"
                    lbl_txt = f"{idx} ({sec_left}s)" if sec_left > 0 else f"{idx}"
                else:
                    bg, fg = "#45475a", "#a6adc8"
                    lbl_txt = f"{idx} (D)"

                border_bg = "#ffffff" if is_active else "#181825"
                card = tk.Frame(grid, bg=border_bg, padx=1, pady=1)
                card.grid(row=i // 2, column=i % 2, padx=1, pady=1, sticky="ew")

                btn = tk.Button(
                    card,
                    text=lbl_txt,
                    font=("Segoe UI", 8, "bold"),
                    bg=bg,
                    fg=fg,
                    activebackground=bg,
                    activeforeground=fg,
                    bd=0,
                    padx=2,
                    pady=1,
                    width=4,
                    cursor="hand2",
                    command=lambda k=idx: self.select_key(k),
                )
                btn.bind("<Button-3>", lambda e, k=idx: self.reset_key(k))
                btn.pack(fill=tk.BOTH, expand=True)

        m_short = MODEL_SHORT.get(self.active_model, "G")
        self.status_lbl.config(text=f"{m_short} • K{self.active_key_index}", fg="#a6adc8")

    def close(self):
        self.running = False
        if self.anim_job:
            self.root.after_cancel(self.anim_job)
        try:
            cmd = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stop-proxy.bat")
            subprocess.Popen(
                ["cmd.exe", "/c", cmd],
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000),
            )
        except Exception:
            pass
        self.root.destroy()


if __name__ == "__main__":
    root = tk.Tk()
    app = ProxyWidget(root)
    root.mainloop()