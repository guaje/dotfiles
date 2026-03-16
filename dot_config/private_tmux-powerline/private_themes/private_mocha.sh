# shellcheck shell=bash
# Catppuccin Mocha Theme for tmux-powerline
# Match catppuccin_mocha_tmux.conf

if tp_patched_font_in_use; then
	TMUX_POWERLINE_SEPARATOR_LEFT_BOLD=""
	TMUX_POWERLINE_SEPARATOR_LEFT_THIN=""
	TMUX_POWERLINE_SEPARATOR_RIGHT_BOLD=""
	TMUX_POWERLINE_SEPARATOR_RIGHT_THIN=""
else
	TMUX_POWERLINE_SEPARATOR_LEFT_BOLD="◀"
	TMUX_POWERLINE_SEPARATOR_LEFT_THIN="❮"
	TMUX_POWERLINE_SEPARATOR_RIGHT_BOLD="▶"
	TMUX_POWERLINE_SEPARATOR_RIGHT_THIN="❯"
fi

# Colors
thm_bg="#1e1e2e"
thm_fg="#cdd6f4"
thm_mauve="#cba6f7"
thm_red="#f38ba8"
thm_peach="#fab387"
thm_yellow="#f9e2af"
thm_green="#a6e3a1"
thm_teal="#94e2d5"
thm_sky="#89dceb"
thm_blue="#89b4fa"
thm_lavender="#b4befe"
thm_surface_0="#313244"
thm_surface_1="#45475a"

TMUX_POWERLINE_DEFAULT_BACKGROUND_COLOR=${TMUX_POWERLINE_DEFAULT_BACKGROUND_COLOR:-$thm_bg}
TMUX_POWERLINE_DEFAULT_FOREGROUND_COLOR=${TMUX_POWERLINE_DEFAULT_FOREGROUND_COLOR:-$thm_fg}

TMUX_POWERLINE_DEFAULT_LEFTSIDE_SEPARATOR=${TMUX_POWERLINE_DEFAULT_LEFTSIDE_SEPARATOR:-$TMUX_POWERLINE_SEPARATOR_RIGHT_BOLD}
TMUX_POWERLINE_DEFAULT_RIGHTSIDE_SEPARATOR=${TMUX_POWERLINE_DEFAULT_RIGHTSIDE_SEPARATOR:-$TMUX_POWERLINE_SEPARATOR_LEFT_BOLD}

if [ -z "$TMUX_POWERLINE_WINDOW_STATUS_CURRENT" ]; then
	TMUX_POWERLINE_WINDOW_STATUS_CURRENT=(
		"#[fg=$thm_mauve,bg=$thm_bg,nobold]"
		"$TMUX_POWERLINE_SEPARATOR_LEFT_BOLD"
		"#[fg=$thm_bg,bg=$thm_mauve,bold]"
		" #W "
		"#[fg=$thm_mauve,bg=$thm_bg,nobold]"
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
		"#[fg=$thm_surface_0,bg=$thm_bg,nobold]"
		"$TMUX_POWERLINE_SEPARATOR_LEFT_BOLD"
		"#[fg=$thm_fg,bg=$thm_surface_0]"
		" #W "
		"#[fg=$thm_surface_0,bg=$thm_bg,nobold]"
		"$TMUX_POWERLINE_SEPARATOR_RIGHT_BOLD"
	)
fi

if [ -z "$TMUX_POWERLINE_LEFT_STATUS_SEGMENTS" ]; then
	TMUX_POWERLINE_LEFT_STATUS_SEGMENTS=(
		"tmux_session_info $thm_mauve $thm_bg"
		"window_name $thm_blue $thm_bg"
		"lan_ip $thm_teal $thm_bg ${TMUX_POWERLINE_SEPARATOR_RIGHT_THIN}"
		"wan_ip $thm_teal $thm_bg"
	)
fi

if [ -z "$TMUX_POWERLINE_RIGHT_STATUS_SEGMENTS" ]; then
	TMUX_POWERLINE_RIGHT_STATUS_SEGMENTS=(
		"pwd $thm_peach $thm_bg"
		"load $thm_yellow $thm_bg"
		"date $thm_lavender $thm_bg ${TMUX_POWERLINE_SEPARATOR_LEFT_THIN}"
		"utc_with_diff $thm_lavender $thm_bg ${TMUX_POWERLINE_SEPARATOR_LEFT_THIN}"
	)
fi
