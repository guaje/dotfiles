#!/usr/bin/env bash
# Shared isolated chezmoi fixture for secret-hook integration tests.
# Nothing below TEST_FIXTURE is allowed to point at the caller's HOME/source.

setup_secret_fixture() {
    local script_dir repo key recipient fixture_parent configured_source
    script_dir=$(CDPATH='' cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
    repo=$(CDPATH='' cd "$script_dir/.." && pwd)
    REAL_HOME_SENTINEL=${HOME:-}
    REAL_HOME_SENTINEL_PATH=
    REAL_HOME_SENTINEL_SUM=
    if [ -f "$REAL_HOME_SENTINEL/.profile" ]; then
        REAL_HOME_SENTINEL_PATH="$REAL_HOME_SENTINEL/.profile"
        REAL_HOME_SENTINEL_SUM=$(cksum "$REAL_HOME_SENTINEL_PATH")
    fi
    REAL_REPO_SENTINEL=$(cksum "$repo/scripts/check-secrets.sh" "$repo/scripts/check-secrets.awk" | cksum)
    fixture_parent=$(CDPATH='' cd -- "${TMPDIR:-/tmp}" && pwd -P)
    TEST_FIXTURE=$(mktemp -d "$fixture_parent/chezmoi-secret-tests.XXXXXX")
    TEST_FIXTURE_ROOT=$TEST_FIXTURE
    TEST_FIXTURE_PARENT=$fixture_parent
    mkdir -p "$TEST_FIXTURE/home" "$TEST_FIXTURE/config/chezmoi" "$TEST_FIXTURE/cache" "$TEST_FIXTURE/state"
    cp -R -p "$repo/." "$TEST_FIXTURE/source"
    mkdir -p "$TEST_FIXTURE/home/.local/share"
    ln -s "$TEST_FIXTURE/source" "$TEST_FIXTURE/home/.local/share/chezmoi"
    export HOME="$TEST_FIXTURE/home"
    export XDG_CONFIG_HOME="$TEST_FIXTURE/config"
    export XDG_CACHE_HOME="$TEST_FIXTURE/cache"
    export CHEZMOI_CONFIG_FILE="$XDG_CONFIG_HOME/chezmoi/chezmoi.toml"
    unset CHEZMOI_SOURCE_DIR CHEZMOI_DEST_DIR CHEZMOI_WORKING_TREE CHEZMOI_CACHE_DIR CHEZMOI_ARGS TEST_CHOICE CHECK_SECRETS_BYPASS CHECK_SECRETS_FAILPOINT
    key="$HOME/.config/chezmoi/key.txt"
    mkdir -p "$(dirname "$key")"
    age-keygen -o "$key" >/dev/null
    recipient=$(awk -F: '/public key:/ {gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; exit}' "$key")
    cat > "$CHEZMOI_CONFIG_FILE" <<EOF
encryption = "age"
[chezmoi]
    sourceDir = "$TEST_FIXTURE/source"
[age]
    identity = "$key"
    recipient = "$recipient"
[secret]
    command = "sh"
    args = ["-c", "export SOPS_AGE_KEY_FILE=\$(eval echo \"\$SOPS_AGE_KEY_FILE\"); exec sops \"\$@\"", "--"]
[env]
    SOPS_AGE_KEY_FILE = "$key"
[hooks.add.pre]
    command = "bash"
    args = ["-c", "exec \"\$CHEZMOI_SOURCE_DIR/scripts/check-secrets.sh\" \"\$@\"", "--"]
EOF
    export SOPS_AGE_KEY_FILE="$key"
    export TEST_FIXTURE_SOURCE="$TEST_FIXTURE/source"

    # Exercise the checked-in config template as TOML, rather than relying
    # solely on this fixture's intentionally minimal duplicate config.
    local rendered_config
    rendered_config="$TEST_FIXTURE/rendered-chezmoi.toml"
    chezmoi execute-template < "$TEST_FIXTURE/source/.chezmoi.toml.tmpl" > "$rendered_config"
    grep -Fq '[hooks.add.pre]' "$rendered_config"
    grep -Fq 'scripts/check-secrets.sh' "$rendered_config"
    grep -Fq '[hooks.update.pre]' "$rendered_config"
    grep -Fq '[hooks.update.post]' "$rendered_config"
    # shellcheck disable=SC2016 # These are literal launcher fragments.
    grep -Fq '$CHEZMOI_SOURCE_DIR/scripts/check-secrets.sh' "$rendered_config"
    # shellcheck disable=SC2016 # These are literal launcher fragments.
    grep -Fq '$CHEZMOI_SOURCE_DIR/scripts/check-removed-files.sh' "$rendered_config"
    # shellcheck disable=SC2016 # Detect forbidden literal command substitution.
    if grep -Fq '$(chezmoi source-path)' "$rendered_config"; then
        printf '❌ hook launcher recursively invokes chezmoi and can deadlock\n' >&2
        return 1
    fi
    configured_source=$(chezmoi --config "$rendered_config" --source "$TEST_FIXTURE/source" \
        --destination "$HOME" source-path)
    configured_source=$(CDPATH='' cd -- "$configured_source" && pwd -P)
    if [ "$configured_source" != "$TEST_FIXTURE_SOURCE" ]; then
        printf '❌ fixture source mismatch: expected %s, got %s\n' \
            "$TEST_FIXTURE_SOURCE" "$configured_source" >&2
        return 1
    fi
}

prospective_fixture_mapping() {
    local target=$1 destination=${2:-$HOME} oracle source mapped relative
    case $target in
        /*) ;;
        *) target=$destination/$target ;;
    esac
    oracle=$(mktemp -d "${TMPDIR:-/tmp}/chezmoi-oracle.XXXXXX")
    chmod 700 "$oracle"
    source="$oracle/source"; mkdir "$source"
    cp -R -p "$(chezmoi source-path)/." "$source/"
    CHECK_SECRETS_BYPASS=1 chezmoi --config /dev/null --config-format toml --cache "$oracle/cache" --persistent-state "$oracle/state" --source "$source" --destination "$destination" add "$target" >/dev/null
    mapped=$(chezmoi --config /dev/null --config-format toml --cache "$oracle/cache" --persistent-state "$oracle/state" --source "$source" --destination "$destination" source-path "$target")
    relative=${mapped#"$source"/}
    rm -rf "$oracle"
    printf '%s/%s\n' "$(chezmoi source-path)" "$relative"
}

finish_secret_fixture() {
    local repo_now
    repo_now=$(cksum "$(CDPATH='' cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/check-secrets.sh" "$(CDPATH='' cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/check-secrets.awk" | cksum)
    [ "$repo_now" = "$REAL_REPO_SENTINEL" ] || { printf '❌ real source sentinel changed\n' >&2; return 1; }
    if [ -n "$REAL_HOME_SENTINEL_PATH" ]; then
        [ "$(cksum "$REAL_HOME_SENTINEL_PATH")" = "$REAL_HOME_SENTINEL_SUM" ] || { printf '❌ real HOME sentinel changed\n' >&2; return 1; }
    fi
    [ "$HOME" = "$TEST_FIXTURE_ROOT/home" ] || { printf '❌ fixture HOME escaped\n' >&2; return 1; }
    case $TEST_FIXTURE_ROOT in "$TEST_FIXTURE_PARENT"/chezmoi-secret-tests.*) rm -rf "$TEST_FIXTURE_ROOT" ;; *) printf '❌ refusing fixture cleanup outside validated root\n' >&2; return 1 ;; esac
}
