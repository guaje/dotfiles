# shellcheck shell=bash
# Prints the current time in UTC with difference with local time.

run_segment() {
	utc_time=$(date -u +"%H:%M")
	diff=$(date +"%z")
	# Format +HHMM to +HH:MM
	formatted_diff="${diff:0:3}:${diff:3:2}"
	echo "${utc_time} UTC (${formatted_diff})"
	return 0
}
