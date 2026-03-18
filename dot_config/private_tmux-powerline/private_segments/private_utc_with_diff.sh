# shellcheck shell=bash
# Prints the current time in UTC with difference with local time.

run_segment() {
	utc_date=$(date -u +"%m-%d")
	utc_time=$(date -u +"%I:%M %p")
	diff=$(date +"%z")
	# Format +HHMM to +HH:MM
	formatted_diff="${diff:0:3}:${diff:3:2}"
	echo "󰥔 ${utc_date} ${utc_time} UTC (${formatted_diff})"
	return 0
}
