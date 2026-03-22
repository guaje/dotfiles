#!/bin/bash

# Configuration: Sensitive patterns to look for
SENSITIVE_PATTERNS=("API_KEY" "PASSWORD" "SECRET" "TOKEN" "AUTH")
SOURCE_DIR=$(chezmoi source-path)
# Extract age public key for SOPS
AGE_KEY=$(grep "public key:" ~/.config/chezmoi/key.txt | cut -d: -f2 | xargs)

# --- LOOP PREVENTION ---
# Check if --encrypt or -e is present in the command arguments
# This prevents the hook from re-triggering itself in an infinite loop
for arg in "$@"; do
    if [[ "$arg" == "--encrypt" ]] || [[ "$arg" == "-e" ]]; then
        exit 0
    fi
done

# Also check CHEZMOI_ARGS environment variable as a fallback
if [[ "$CHEZMOI_ARGS" == *"--encrypt"* ]] || [[ "$CHEZMOI_ARGS" == *" -e "* ]]; then
    exit 0
fi
# -----------------------

# Identify files to add from arguments
FILES_TO_ADD=()
for arg in "$@"; do
    if [[ "$arg" == "add" ]]; then continue; fi
    if [[ "$arg" == -* ]]; then continue; fi # Skip flags
    FILES_TO_ADD+=("$arg")
done

# Check if any files were passed. If not, try to read from CHEZMOI_ARGS
if [ ${#FILES_TO_ADD[@]} -eq 0 ] && [ -n "$CHEZMOI_ARGS" ]; then
    read -ra ALL_ARGS <<< "$CHEZMOI_ARGS"
    for arg in "${ALL_ARGS[@]}"; do
        if [[ "$arg" == "add" ]]; then continue; fi
        if [[ "$arg" == -* ]]; then continue; fi
        FILES_TO_ADD+=("$arg")
    done
fi

for file in "${FILES_TO_ADD[@]}"; do
    if [ ! -f "$file" ]; then continue; fi

    FOUND_SENSITIVE=false
    for pattern in "${SENSITIVE_PATTERNS[@]}"; do
        if grep -qi "$pattern" "$file"; then
            FOUND_SENSITIVE=true
            MATCHED_PATTERN="$pattern"
            break
        fi
    done

    if [ "$FOUND_SENSITIVE" = true ]; then
        # Use /dev/tty to ensure messages are visible
        echo "⚠️  WARNING: Sensitive information detected in $file (pattern: $MATCHED_PATTERN)" > /dev/tty
        echo "How would you like to proceed?" > /dev/tty
        echo "1) Full Encryption: chezmoi add --encrypt $file" > /dev/tty
        echo "2) SOPS Strategy: Encrypt with SOPS and move to source as .sops.yaml" > /dev/tty
        echo "3) Plain: Add as a plain file (NOT RECOMMENDED)" > /dev/tty
        echo "4) Abort" > /dev/tty
        
        # Read user input: Use TEST_CHOICE env var if set, otherwise read from /dev/tty
        if [ -n "$TEST_CHOICE" ]; then
            choice="$TEST_CHOICE"
            echo "Auto-selecting option: $choice" > /dev/tty
        else
            read -p "Select an option [1-4]: " choice < /dev/tty
        fi

        case $choice in
            1)
                echo "Running: chezmoi add --encrypt $file" > /dev/tty
                # This call triggers the hook again, but the loop prevention above will catch it
                chezmoi add --encrypt "$file"
                exit 1 # Stop the original unencrypted 'add' command
                ;;
            2)
                DEST_NAME="$(basename "$file").sops.yaml"
                DEST_PATH="$SOURCE_DIR/$DEST_NAME"
                echo "Encrypting with SOPS to $DEST_PATH..." > /dev/tty
                sops --encrypt --age "$AGE_KEY" "$file" > "$DEST_PATH"
                echo "✅ File encrypted and moved to source directory." > /dev/tty
                echo "You can now reference it in templates using: (secret \"-d\" (joinPath .chezmoi.sourceDir \"$DEST_NAME\") | fromYaml)" > /dev/tty
                exit 1
                ;;
            3)
                echo "Proceeding with plain add." > /dev/tty
                ;;
            *)
                echo "Aborting." > /dev/tty
                exit 1
                ;;
        esac
    fi
done

exit 0
