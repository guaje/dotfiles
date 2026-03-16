# shellcheck shell=bash
# Prints the current system load average with a label.

run_segment() {
	load=$(uptime | cut -d "," -f 3- | cut -d ":" -f2 | sed -e "s/^[ \t]*//")
	# Split by spaces and remove trailing commas
	read -r load1 load5 load15 <<< "${load//,/}"
	echo "1m:${load1} 5m:${load5} 15m:${load15}"
	return 0
}
