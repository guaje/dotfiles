# shellcheck shell=bash
# Catppuccin Mocha Theme for tmux-powerline
# Match catppuccin_mocha_tmux.conf

if tp_patched_font_in_use; then
	export TMUX_POWERLINE_SEPARATOR_LEFT_BOLD=""
	export TMUX_POWERLINE_SEPARATOR_LEFT_THIN=""
	export TMUX_POWERLINE_SEPARATOR_RIGHT_BOLD=""
	export TMUX_POWERLINE_SEPARATOR_RIGHT_THIN=""
else
	export TMUX_POWERLINE_SEPARATOR_LEFT_BOLD="◀"
	export TMUX_POWERLINE_SEPARATOR_LEFT_THIN="❮"
	export TMUX_POWERLINE_SEPARATOR_RIGHT_BOLD="▶"
	export TMUX_POWERLINE_SEPARATOR_RIGHT_THIN="❯"
fi

# --> Catppuccin (Mocha)
export thm_bg="#1e1e2e"
export thm_fg="#cdd6f4"

# Colors
export thm_rosewater="#f5e0dc"
export thm_flamingo="#f2cdcd"
export thm_pink="#f5c2e7"
export thm_mauve="#cba6f7"
export thm_red="#f38ba8"
export thm_maroon="#eba0ac"
export thm_peach="#fab387"
export thm_yellow="#f9e2af"
export thm_green="#a6e3a1"
export thm_teal="#94e2d5"
export thm_sky="#89dceb"
export thm_sapphire="#74c7ec"
export thm_blue="#89b4fa"
export thm_lavender="#b4befe"

# Surfaces and overlays
export thm_subtext_1="#a6adc8"
export thm_subtext_0="#bac2de"
export thm_overlay_2="#9399b2"
export thm_overlay_1="#7f849c"
export thm_overlay_0="#6c7086"
export thm_surface_2="#585b70"
export thm_surface_1="#45475a"
export thm_surface_0="#313244"
export thm_mantle="#181825"
export thm_crust="#11111b"

TMUX_POWERLINE_DEFAULT_BACKGROUND_COLOR=${TMUX_POWERLINE_DEFAULT_BACKGROUND_COLOR:-$thm_bg}
TMUX_POWERLINE_DEFAULT_FOREGROUND_COLOR=${TMUX_POWERLINE_DEFAULT_FOREGROUND_COLOR:-$thm_fg}

TMUX_POWERLINE_DEFAULT_LEFTSIDE_SEPARATOR=""
TMUX_POWERLINE_DEFAULT_RIGHTSIDE_SEPARATOR=""

export TMUX_POWERLINE_SEG_TMUX_SESSION_INFO_FORMAT="#[fg=$thm_mauve,bg=$thm_bg,nobold]$TMUX_POWERLINE_SEPARATOR_LEFT_BOLD#[fg=$thm_bg,bg=$thm_mauve,bold]#[fg=$thm_fg,bg=$thm_surface_0,nobold] #S:#I.#P#[fg=$thm_surface_0,bg=$thm_bg,nobold]$TMUX_POWERLINE_SEPARATOR_RIGHT_BOLD"
export TMUX_POWERLINE_SEG_LAN_IP_SYMBOL="󰩠"
export TMUX_POWERLINE_SEG_WAN_IP_SYMBOL="󰖈"

if [ -z "$TMUX_POWERLINE_WINDOW_STATUS_CURRENT" ]; then
	TMUX_POWERLINE_WINDOW_STATUS_CURRENT=(
		"#[fg=$thm_mauve,bg=$thm_bg,nobold]"
		"$TMUX_POWERLINE_SEPARATOR_LEFT_BOLD"
		"#[fg=$thm_bg,bg=$thm_mauve,nobold]"
		"#I#F"
		"#[fg=$thm_fg,bg=$thm_surface_1,nobold]"
		" #W#{?window_zoomed_flag,(󰊓),}"
		"#[fg=$thm_surface_1,bg=$thm_bg,nobold]"
		"$TMUX_POWERLINE_SEPARATOR_RIGHT_BOLD"
	)
fi

if [ -z "$TMUX_POWERLINE_WINDOW_STATUS_STYLE" ]; then
	TMUX_POWERLINE_WINDOW_STATUS_STYLE=(
		"$(tp_format regular)"
	)
fi

if [ -z "$TMUX_POWERLINE_WINDOW_STATUS_FORMAT" ]; then
	TMUX_POWERLINE_WINDOW_STATUS_FORMAT=(
		"#[fg=$thm_overlay_2,bg=$thm_bg,nobold]"
		"$TMUX_POWERLINE_SEPARATOR_LEFT_BOLD"
		"#[fg=$thm_bg,bg=$thm_overlay_2,nobold]"
		"#I#F"
		"#[fg=$thm_fg,bg=$thm_surface_0,nobold]"
		" #W#{?window_zoomed_flag,(󰊓),}"
		"#[fg=$thm_surface_0,bg=$thm_bg,nobold]"
		"$TMUX_POWERLINE_SEPARATOR_RIGHT_BOLD"
	)
fi

if [ -z "$TMUX_POWERLINE_LEFT_STATUS_SEGMENTS" ]; then
	TMUX_POWERLINE_LEFT_STATUS_SEGMENTS=(
		"tmux_session_info $thm_bg $thm_bg"
		"window_name $thm_bg $thm_bg"
		"pwd $thm_bg $thm_bg"
	)
fi

if [ -z "$TMUX_POWERLINE_RIGHT_STATUS_SEGMENTS" ]; then
	TMUX_POWERLINE_RIGHT_STATUS_SEGMENTS=(
		"utc_with_diff $thm_bg $thm_bg"
		"lan_ip $thm_bg $thm_bg"
		"wan_ip $thm_bg $thm_bg"
	)
fi
