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
    mkdir -p "$TEST_FIXTURE/home" "$TEST_FIXTURE/config/chezmoi" "$TEST_FIXTURE/cache" "$TEST_FIXTURE/state" "$TEST_FIXTURE/source"
    cp -R -p "$repo/scripts" "$TEST_FIXTURE/source/scripts" || {
        printf '❌ fixture input missing\n' >&2
        return 1
    }
    cp -p "$repo/.chezmoi.toml.tmpl" "$repo/.chezmoiignore" "$repo/.sops.yaml" "$TEST_FIXTURE/source/" || {
        printf '❌ fixture input missing\n' >&2
        return 1
    }
    mkdir -p "$TEST_FIXTURE/home/.local/share"
    ln -s "$TEST_FIXTURE/source" "$TEST_FIXTURE/home/.local/share/chezmoi"
    export HOME="$TEST_FIXTURE/home"
    TEST_ROOT="$HOME/.test"
    CONFIG_TEST_ROOT="$HOME/.config/test"
    SOURCE_NAMING_TEST_ROOT="$HOME/.test_dir/test_subdir"
    export XDG_CONFIG_HOME="$TEST_FIXTURE/config"
    export XDG_CACHE_HOME="$TEST_FIXTURE/cache"
    export CHEZMOI_CONFIG_FILE="$XDG_CONFIG_HOME/chezmoi/chezmoi.toml"
    unset CHEZMOI_SOURCE_DIR CHEZMOI_DEST_DIR CHEZMOI_WORKING_TREE CHEZMOI_CACHE_DIR CHEZMOI_ARGS TEST_CHOICE CHECK_SECRETS_BYPASS CHECK_SECRETS_FAILPOINT
    export CHECK_SECRETS_NO_TTY=true
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
    configured_source=$(chezmoi source-path)
    if [[ ! $configured_source -ef $TEST_FIXTURE_SOURCE ]]; then
        printf '❌ fixture source-path escaped the isolated source\n' >&2
        return 1
    fi
    # Keep the same spelling returned by chezmoi. Path helpers strip this
    # prefix when deriving sidecar paths, and the configured source may be the
    # conventional symlink to the isolated physical fixture directory.
    SOURCE_DIR=$configured_source
}

assert_hook_launcher_contract() {
    local rendered_config configured_source
    rendered_config="$TEST_FIXTURE/rendered-chezmoi.toml"
    chezmoi execute-template < "$SOURCE_DIR/.chezmoi.toml.tmpl" > "$rendered_config" || {
        printf '❌ config template failed to render\n' >&2
        return 1
    }
    if ! grep -Fq '[hooks.add.pre]' "$rendered_config" \
        || ! grep -Fq '[hooks.update.pre]' "$rendered_config" \
        || ! grep -Fq '[hooks.update.post]' "$rendered_config"; then
        printf '❌ required hook is absent from rendered config\n' >&2
        return 1
    fi
    # shellcheck disable=SC2016 # These are literal launcher fragments.
    grep -Fq '$CHEZMOI_SOURCE_DIR/scripts/check-secrets.sh' "$rendered_config" || {
        printf '❌ add hook does not use the exported source path\n' >&2
        return 1
    }
    # shellcheck disable=SC2016 # These are literal launcher fragments.
    grep -Fq '$CHEZMOI_SOURCE_DIR/scripts/check-removed-files.sh' "$rendered_config" || {
        printf '❌ update hooks do not use the exported source path\n' >&2
        return 1
    }
    # shellcheck disable=SC2016 # Detect forbidden literal command substitution.
    if grep -Fq '$(chezmoi source-path)' "$rendered_config"; then
        printf '❌ hook launcher recursively invokes chezmoi\n' >&2
        return 1
    fi
    configured_source=$(chezmoi --config "$rendered_config" --source "$SOURCE_DIR" \
        --destination "$HOME" source-path) || return 1
    configured_source=$(CDPATH='' cd -- "$configured_source" && pwd -P) || return 1
    [[ $configured_source == "$TEST_FIXTURE_SOURCE" ]] || {
        printf '❌ rendered config escaped the fixture source\n' >&2
        return 1
    }
}

run_chezmoi_add() {
    local choice=$1
    shift
    env TEST_CHOICE="$choice" chezmoi add "$@"
}

prepare_test_dirs() {
    mkdir -p "$TEST_ROOT" "$CONFIG_TEST_ROOT" "$SOURCE_NAMING_TEST_ROOT"
}

template_source_path() {
    chezmoi source-path "$1"
}

sops_source_path() {
    local source_file rel_path
    source_file=$(template_source_path "$1")
    source_file=${source_file%.tmpl}
    rel_path=${source_file#"$SOURCE_DIR"/}
    printf '%s/secrets/%s.sops.yaml\n' "$SOURCE_DIR" "$rel_path"
}

write_option2_yaml_fixture() {
    cat <<'EOF' > "$TEST_ROOT/test_data.yaml"
app_name: MyTestApp
API_KEY: yaml-secret-key
port: 8080
db_password: yaml-db-pass
EOF
}

write_option2_json_fixture() {
    cat <<'EOF' > "$TEST_ROOT/test_data.json"
{
  "app_name": "MyTestApp",
  "apiKey": "json-secret-key",
  "dbPassword": "json-db-pass",
  "port": 8080
}
EOF
}

write_option2_toml_fixture() {
    cat <<'EOF' > "$TEST_ROOT/test_data.toml"
app_name = "MyTestApp"
API_KEY = "toml-secret-key"
port = 8080
db_password = "toml-db-pass"
EOF
}

write_option2_duplicate_fixture() {
    printf '%s\n' '{"hosts": [{"username": "username1", "password": "password1"}, {"username": "username2", "password": "password2"}]}' > "$TEST_ROOT/test_multi.json"
}

write_option2_subdirectory_fixture() {
    cat <<'EOF' > "$CONFIG_TEST_ROOT/test_sub.yaml"
API_KEY: sub-secret-key
db_password: sub-db-pass
EOF
}

write_option2_source_naming_fixture() {
    cat <<'EOF' > "$SOURCE_NAMING_TEST_ROOT/test_chezmoi_naming.json"
{
  "service": "chezmoi-naming-test",
  "API_KEY": "chezmoi-naming-secret",
  "enabled": true
}
EOF
}

prospective_fixture_mapping() {
    local target=$1 destination=${2:-$HOME} oracle oracle_parent source mapped relative
    case $target in
        /*) ;;
        *) target=$destination/$target ;;
    esac
    oracle_parent=$(CDPATH='' cd -- "${TMPDIR:-/tmp}" && pwd -P)
    oracle=$(mktemp -d "$oracle_parent/chezmoi-oracle.XXXXXX")
    chmod 700 "$oracle"
    source="$oracle/source"; mkdir "$source"
    cp -R -p "$(chezmoi source-path)/." "$source/"
    CHECK_SECRETS_BYPASS=1 chezmoi --config /dev/null --config-format toml --cache "$oracle/cache" --persistent-state "$oracle/state" --source "$source" --destination "$destination" add "$target" >/dev/null
    mapped=$(chezmoi --config /dev/null --config-format toml --cache "$oracle/cache" --persistent-state "$oracle/state" --source "$source" --destination "$destination" source-path "$target")
    relative=${mapped#"$source"/}
    rm -rf "$oracle"
    printf '%s/%s\n' "$SOURCE_DIR" "$relative"
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
