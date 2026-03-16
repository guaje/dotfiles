# shellcheck shell=bash
# Prints the current pane working directory with a Nerd Font icon.

run_segment() {
	path=$(tmux display-message -p '#{pane_current_path}')
	home="${HOME%/}"
	max_len="${TMUX_POWERLINE_SEG_PWD_MAX_LEN:-40}"

	if [ -n "$home" ] && [ "${path#$home}" != "$path" ]; then
		path="~${path#$home}"
	fi

	if [ -n "$max_len" ] && [ "$max_len" -gt 1 ] 2>/dev/null && [ "${#path}" -gt "$max_len" ]; then
		path="…${path: -$((max_len - 1))}"
	fi

	echo " $path"
	return 0
}
