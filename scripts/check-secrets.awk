function trim(value) {
    sub(/^[[:space:]]+/, "", value)
    sub(/[[:space:]]+$/, "", value)
    return value
}

function rtrim(value) {
    sub(/[[:space:]]+$/, "", value)
    return value
}

function normalize(value) {
    value = toupper(value)
    gsub(/[^A-Z0-9]/, "", value)
    return value
}

function is_placeholder(value, upper) {
    value = trim(value)
    upper = toupper(value)

    if (upper == "") {
        return 1
    }
    if (upper ~ /^([*]+|X+|Y+|Z+)$/) {
        return 1
    }
    if (upper ~ /^(REDACTED|MASKED|SECRET|TOKEN|PASSWORD|PASS|APIKEY|API_KEY|KEY|EXAMPLE|CHANGEME|CHANGE_ME|TODO|TBD|DUMMY|PLACEHOLDER)$/) {
        return 1
    }
    if (upper ~ /^(YOUR|INSERT|SET|REPLACE|EXAMPLE)_[A-Z0-9_]+$/) {
        return 1
    }
    if (upper ~ /^<[^>]+>$/) {
        return 1
    }
    if (upper ~ /^\{\{[^}]+\}\}$/) {
        return 1
    }
    return 0
}

function has_strong_pattern(value) {
    if (value ~ /-----BEGIN ([A-Z0-9 ]+ )?PRIVATE KEY-----/) {
        strong_label = "PRIVATE_KEY_BLOCK"
        return 1
    }
    if (value ~ /AGE-SECRET-KEY-1[0-9A-Z]+/) {
        strong_label = "AGE_SECRET_KEY"
        return 1
    }
    if (value ~ /github_pat_[A-Za-z0-9_]{20,}/) {
        strong_label = "GITHUB_FINE_GRAINED_PAT"
        return 1
    }
    if (value ~ /ghs_[A-Za-z0-9_]{20,}/) {
        strong_label = "GITHUB_APP_TOKEN"
        return 1
    }
    if (value ~ /gh[pour]_[A-Za-z0-9_]{20,}/) {
        strong_label = "GITHUB_TOKEN"
        return 1
    }
    if (value ~ /glpat-[A-Za-z0-9_-]{20,}/) {
        strong_label = "GITLAB_TOKEN"
        return 1
    }
    if (value ~ /xox(a|b|p|r|s)-[A-Za-z0-9-]{10,}/) {
        strong_label = "SLACK_TOKEN"
        return 1
    }
    if (value ~ /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_\/-]+/) {
        strong_label = "SLACK_WEBHOOK"
        return 1
    }
    if (value ~ /(^|[^A-Z0-9])(AKIA|ASIA|AGPA|AIDA|AROA|AIPA)[A-Z0-9]{16}([^A-Z0-9]|$)/) {
        strong_label = "AWS_ACCESS_KEY_ID"
        return 1
    }
    if (value ~ /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/) {
        strong_label = "JWT"
        return 1
    }
    if (value ~ /(sk|rk)_(live|test)_[A-Za-z0-9]{16,}/) {
        strong_label = "STRIPE_KEY"
        return 1
    }
    if (value ~ /AIza[0-9A-Za-z_-]{35}/) {
        strong_label = "GOOGLE_API_KEY"
        return 1
    }
    if (value ~ /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/) {
        strong_label = "SENDGRID_KEY"
        return 1
    }
    if (value ~ /xb-[0-9]+-[A-Za-z0-9]{20,}/) {
        strong_label = "SLACK_BOT_TOKEN"
        return 1
    }
    if (value ~ /npm_[A-Za-z0-9]{36}/) {
        strong_label = "NPM_TOKEN"
        return 1
    }
    if (value ~ /npma-[A-Za-z0-9_-]{20,}/) {
        strong_label = "NPM_AUTOMATION_TOKEN"
        return 1
    }
    if (value ~ /hf_[A-Za-z0-9]{30,}/) {
        strong_label = "HUGGINGFACE_TOKEN"
        return 1
    }
    if (value ~ /dapi[0-9a-f]{32}/) {
        strong_label = "DATADOG_API_KEY"
        return 1
    }
    if (value ~ /dop_v1_[A-Za-z0-9]{20,}/) {
        strong_label = "DIGITALOCEAN_TOKEN"
        return 1
    }
    if (value ~ /pma[k]?-([A-Za-z0-9_-]{20,}|v[0-9]+-[A-Za-z0-9_-]{20,})/) {
        strong_label = "POSTMAN_API_KEY"
        return 1
    }
    if (value ~ /sk-(proj-)?[A-Za-z0-9_-]{20,}/) {
        strong_label = "OPENAI_KEY"
        return 1
    }
    if (value ~ /sk-ant-[A-Za-z0-9_-]{20,}/) {
        strong_label = "ANTHROPIC_KEY"
        return 1
    }
    if (value ~ /mapi_[A-Za-z0-9]{20,}/) {
        strong_label = "MAILCHIMP_API_KEY"
        return 1
    }
    if (value ~ /pat_[A-Za-z0-9]{20,}/) {
        strong_label = "GENERIC_PAT"
        return 1
    }
    if (value ~ /https:\/\/discord(app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9._-]+/) {
        strong_label = "DISCORD_WEBHOOK"
        return 1
    }
    if (value ~ /sk_live_[0-9a-fA-F]{24,}/) {
        strong_label = "BRAINTREE_KEY"
        return 1
    }
    if (value ~ /shpat_[A-Za-z0-9]{20,}/) {
        strong_label = "SHOPIFY_TOKEN"
        return 1
    }
    if (value ~ /sk_[A-Za-z0-9]{32}/) {
        strong_label = "LOB_API_KEY"
        return 1
    }
    if (value ~ /sq0atp-[A-Za-z0-9_-]{20,}/) {
        strong_label = "SQUARE_TOKEN"
        return 1
    }
    if (value ~ /sq0csp-[A-Za-z0-9_-]{20,}/) {
        strong_label = "SQUARE_SECRET"
        return 1
    }
    if (value ~ /vapid_[A-Za-z0-9_-]{20,}/) {
        strong_label = "VAPID_PRIVATE_KEY"
        return 1
    }
    if (value ~ /key-[0-9a-fA-F]{32}/) {
        strong_label = "MAILGUN_KEY"
        return 1
    }
    if (value ~ /SK[0-9a-fA-F]{32}/) {
        strong_label = "TWILIO_KEY"
        return 1
    }
    if (value ~ /AC[0-9a-fA-F]{32}/) {
        strong_label = "TWILIO_ACCOUNT_SID"
        return 1
    }
    if (value ~ /(EAACEdEose0cBA|EAA[a-zA-Z0-9]{20,})/) {
        strong_label = "FACEBOOK_ACCESS_TOKEN"
        return 1
    }
    if (value ~ /hvs\.[A-Za-z0-9_-]{20,}/) {
        strong_label = "HASHICORP_VAULT_TOKEN"
        return 1
    }
    if (value ~ /(sk|pk)\.[a-z0-9]{20,}\.[a-z0-9]{20,}/) {
        strong_label = "MAPBOX_TOKEN"
        return 1
    }
    if (value ~ /0\/[0-9]{16}:[A-Za-z0-9]{32}/) {
        strong_label = "ASANA_PAT"
        return 1
    }
    if (value ~ /ya29\.[A-Za-z0-9_-]+/) {
        strong_label = "GOOGLE_OAUTH_TOKEN"
        return 1
    }
    return 0
}

function looks_like_sensitive_key(key, normalized, lower, i) {
    normalized = normalize(key)
    for (i = 1; i <= pattern_count; i++) {
        if (normalized_patterns[i] != "" && index(normalized, normalized_patterns[i])) {
            return 1
        }
    }

    lower = tolower(key)
    if (lower ~ /(^|[_.-])((api|access|auth|session|bearer|refresh|identity)[_.-]?)?(token|secret|password|passwd|passphrase|credential|cookie|key)($|[_.-])/) {
        return 1
    }
    if (lower ~ /(^|[_.-])(client|consumer|private|public|signing|encryption|webhook|license|ssh|pgp|gpg|age|database|db|smtp|ldap|oauth|jwt)[_.-]?(key|secret|token|password|dsn|connection|string)($|[_.-])/) {
        return 1
    }
    return 0
}

function looks_like_secret_value(value, compact) {
    value = trim(value)
    if (is_placeholder(value)) {
        return 0
    }
    if (has_strong_pattern(value)) {
        return 1
    }

    compact = value
    if (compact ~ /^[A-Fa-f0-9]{24,}$/) {
        return 1
    }
    if (compact ~ /^[A-Za-z0-9+\/=]{32,}$/ && compact !~ /^[A-Za-z]+$/) {
        return 1
    }
    return 0
}

function unquote(value, quote) {
    value = trim(value)
    quote = substr(value, 1, 1)
    if ((quote == "\"" || quote == "'") && substr(value, length(value), 1) == quote) {
        return substr(value, 2, length(value) - 2)
    }
    return value
}

function add_occurrence(line_no, key, value, replace_start, replace_len) {
    occurrence_count++
    occurrence_line[occurrence_count] = line_no
    occurrence_key[occurrence_count] = key
    occurrence_value[occurrence_count] = value
    occurrence_start[occurrence_count] = replace_start
    occurrence_len[occurrence_count] = replace_len
    key_totals[key]++
}

function scan_line(line, line_no,    rest, base, segment, key, value_part, first_char, i, ch, raw_value, consumed, secret_value, replace_start, replace_len, matched) {
    rest = line
    base = 1

    while (match(rest, /["']?[A-Za-z0-9_.-]+["']?[[:space:]]*[:=][[:space:]]*/)) {
        segment = substr(rest, RSTART, RLENGTH)
        key = segment
        sub(/[[:space:]]*[:=][[:space:]]*$/, "", key)
        gsub(/^["']|["']$/, "", key)

        value_part = substr(rest, RSTART + RLENGTH)
        if (value_part == "") {
            break
        }

        first_char = substr(value_part, 1, 1)
        raw_value = ""
        consumed = 0

        if (first_char == "\"" || first_char == "'") {
            raw_value = first_char
            for (i = 2; i <= length(value_part); i++) {
                ch = substr(value_part, i, 1)
                raw_value = raw_value ch
                if (ch == first_char && substr(value_part, i - 1, 1) != "\\") {
                    break
                }
            }
            consumed = length(raw_value)
            secret_value = unquote(raw_value)
            replace_start = base + RSTART - 1 + RLENGTH + 1
            replace_len = length(secret_value)
        } else {
            for (i = 1; i <= length(value_part); i++) {
                ch = substr(value_part, i, 1)
                if (ch == "," || ch == "}" || ch == "]") {
                    break
                }
                raw_value = raw_value ch
            }
            consumed = length(raw_value)
            secret_value = rtrim(raw_value)
            replace_start = base + RSTART - 1 + RLENGTH
            replace_len = length(secret_value)
        }

        matched = 0
        if (replace_len > 0 && !is_placeholder(secret_value)) {
            if (looks_like_sensitive_key(key) || looks_like_secret_value(secret_value)) {
                matched = 1
            }
        }

        if (matched) {
            if (mode == "detect") {
                detect_found = 1
                detect_line = line_no
                if (strong_label != "") {
                    detect_label = strong_label
                } else {
                    detect_label = key
                }
                return 1
            }
            add_occurrence(line_no, key, secret_value, replace_start, replace_len)
        }

        rest = substr(value_part, consumed + 1)
        base = base + RSTART - 1 + RLENGTH + consumed
    }

    return 0
}

function template_ref(secret_name) {
    return "{{ (index ((secret \"-d\" (joinPath .chezmoi.sourceDir \"secrets/" sops_file_name "\") | fromYaml).data | fromYaml) \"" secret_name "\") }}"
}

function yaml_escape(value) {
    gsub(/'/, "''", value)
    return value
}

BEGIN {
    if (mode == "") {
        mode = "detect"
    }
    if (sensitive_patterns == "") {
        sensitive_patterns = ENVIRON["SENSITIVE_PATTERNS"]
    }

    pattern_count = split(sensitive_patterns, raw_patterns, /\n/)
    normalized_count = 0
    for (i = 1; i <= pattern_count; i++) {
        if (trim(raw_patterns[i]) != "") {
            normalized_count++
            normalized_patterns[normalized_count] = normalize(raw_patterns[i])
        }
    }
    pattern_count = normalized_count
}

{
    lines[++line_count] = $0
    if (mode == "detect" && has_strong_pattern($0)) {
        detect_found = 1
        detect_label = strong_label
        detect_line = line_count
        next
    }
    if (!detect_found) {
        scan_line($0, line_count)
    }
}

END {
    if (mode == "detect") {
        if (detect_found) {
            if (output_format == "tsv") {
                print detect_label "\t" detect_line
            } else {
                print detect_label
            }
            exit 0
        }
        exit 1
    }

    if (occurrence_count == 0) {
        exit 2
    }

    for (i = 1; i <= occurrence_count; i++) {
        key = occurrence_key[i]
        key_seen[key]++
        if (key_totals[key] == 1) {
            occurrence_secret_name[i] = key
        } else {
            occurrence_secret_name[i] = key "__" key_seen[key]
        }
    }

    print "{{- /* chezmoi:template */ -}}" > template_file
    for (line_no = 1; line_no <= line_count; line_no++) {
        output = lines[line_no]
        for (i = occurrence_count; i >= 1; i--) {
            if (occurrence_line[i] != line_no) {
                continue
            }
            output = substr(output, 1, occurrence_start[i] - 1) template_ref(occurrence_secret_name[i]) substr(output, occurrence_start[i] + occurrence_len[i])
        }
        print output >> template_file
    }

    for (i = 1; i <= occurrence_count; i++) {
        print occurrence_secret_name[i] ": '" yaml_escape(occurrence_value[i]) "'" >> secrets_file
    }
}