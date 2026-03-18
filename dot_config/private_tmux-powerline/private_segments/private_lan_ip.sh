# shellcheck shell=bash
# Prints the local network IPv4 address for a statically defined NIC or search for an IPv4 address on all active NICs.
TMUX_POWERLINE_SEG_LAN_IP_SYMBOL="${TMUX_POWERLINE_SEG_LAN_IP_SYMBOL:-󰩠 }"

run_segment() {
        if tp_shell_is_bsd || tp_shell_is_macos; then
                default_route_nic=$(route get default | grep -i interface | awk '{print $2}')
                all_nics=$(ifconfig 2>/dev/null | awk -F':' '/^[a-z]/ && !/^lo/ { print $1 }' | tr '\n' ' ')
                IFS=' ' read -ra all_nics_array <<<"$all_nics"
                # the nic of the default route is considered first
                all_nics_array=("$default_route_nic" "${all_nics_array[@]}")
                for nic in "${all_nics_array[@]}"; do
                        ipv4s_on_nic=$(ifconfig "${nic}" 2>/dev/null | awk '$1 == "inet" { print $2 }')
                        for lan_ip in "${ipv4s_on_nic[@]}"; do
                                [[ -n "${lan_ip}" ]] && break
                        done
                        [[ -n "${lan_ip}" ]] && break
                done
        else
                default_route_nic=$(ip route get 1.1.1.1 2>/dev/null | grep -o "dev.*" | cut -d ' ' -f 2)
                # Get the names of all attached NICs.
                all_nics="$(ip addr show | cut -d ' ' -f2 | tr -d :)"
                all_nics=("${all_nics[@]/lo/}") # Remove lo interface.
                # the nic of the default route is considered first
                all_nics=("$default_route_nic" "${all_nics[@]}")

                for nic in "${all_nics[@]}"; do
                        # Parse IP address for the NIC.
                        lan_ip="$(ip addr show "${nic}" 2>/dev/null | grep '\<inet\>' | tr -s ' ' | cut -d ' ' -f3)"
                        # Trim the CIDR suffix.
                        lan_ip="${lan_ip%/*}"
                        # Only display the last entry
                        lan_ip="$(echo "$lan_ip" | tail -1)"

                        [ -n "$lan_ip" ] && break
                done
        fi

        echo "#[fg=$thm_teal,bg=$thm_bg,nobold]${TMUX_POWERLINE_SEPARATOR_LEFT_BOLD}#[fg=$thm_bg,bg=$thm_teal,bold]${TMUX_POWERLINE_SEG_LAN_IP_SYMBOL}#[fg=$thm_fg,bg=$thm_surface_0,nobold] ${lan_ip-N/a}#[fg=$thm_surface_0,bg=$thm_bg,nobold]${TMUX_POWERLINE_SEPARATOR_RIGHT_BOLD}"
        return 0
}
