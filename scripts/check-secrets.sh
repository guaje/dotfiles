#!/bin/sh

# Configuration: Sensitive patterns to look for
SENSITIVE_PATTERNS=("API_KEY" "PASSWORD" "SECRET" "TOKEN" "AUTH")
SOURCE_DIR=$(chezmoi source-path)
# Extract age public key for SOPS
AGE_KEY=$(grep "public key:" ~/.config/chezmoi/key.txt | cut -d: -f2 | xargs)

# --- LOOP PREVENTION ---
# Check if --encrypt or -e is present in the command arguments
# Also add an exception for .tmpl files to avoid re-triggering the hook
for arg in "$@"; do
    if [[ "$arg" == "--encrypt" ]] || [[ "$arg" == "-e" ]]; then
        exit 0
    fi
    if [[ "$arg" == *.tmpl ]]; then
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
        echo "2) SOPS Strategy: Partial encryption using sops and templates" > /dev/tty
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
                chezmoi add --encrypt "$file"
                exit 1 
                ;;
            2)
                # Ensure the secrets directory exists in the source directory
                mkdir -p "$SOURCE_DIR/secrets"
                
                SOPS_FILE_NAME="$(basename "$file").sops.yaml"
                SOPS_SOURCE_PATH="$SOURCE_DIR/secrets/$SOPS_FILE_NAME"
                TMP_SECRETS_FILE=$(mktemp)
                
                TMP_TEMPLATE_FILE="${file}.tmpl"
                cp "$file" "$TMP_TEMPLATE_FILE"
                
                echo "Identifying and extracting secrets..." > /dev/tty
                
                # Simplified extraction for KEY=VALUE or KEY: VALUE patterns
                for pattern in "${SENSITIVE_PATTERNS[@]}"; do
                    # Find all lines matching the pattern and extract keys/values
                    # Assumes patterns are like API_KEY=value or password: value
                    grep -Ei "$pattern" "$file" | while read -r line; do
                        # Extract key and value using basic delimiters
                        key=$(echo "$line" | cut -d'=' -f1 | cut -d':' -f1 | xargs)
                        value=$(echo "$line" | cut -d'=' -f2- | cut -d':' -f2- | xargs)
                        
                        if [ -n "$key" ] && [ -n "$value" ]; then
                            # Store in temporary yaml for sops
                            echo "${key}: ${value}" >> "$TMP_SECRETS_FILE"
                            
                            # Update the template file with the reference
                            template_ref="{{ (secret \"-d\" (joinPath .chezmoi.sourceDir \"secrets/$SOPS_FILE_NAME\") | fromYaml).${key} }}"
                            # Use sed to replace the literal value with the template reference
                            # This is a bit naive but works for simple values. Escaping might be needed.
                            sed -i "s|${value}|${template_ref}|g" "$TMP_TEMPLATE_FILE"
                        fi
                    done
                done
                
                # Encrypt the secrets file to the source directory
                echo "Creating sops-encrypted file at $SOPS_SOURCE_PATH..." > /dev/tty
                sops --encrypt --age "$AGE_KEY" "$TMP_SECRETS_FILE" > "$SOPS_SOURCE_PATH"
                
                # Add the template to chezmoi
                echo "Adding template $TMP_TEMPLATE_FILE to chezmoi..." > /dev/tty
                chezmoi add "$TMP_TEMPLATE_FILE"
                
                # Cleanup: Delete the original file and the temporary template
                echo "Cleaning up..." > /dev/tty
                rm "$file" "$TMP_TEMPLATE_FILE" "$TMP_SECRETS_FILE"
                
                echo "✅ SOPS strategy complete." > /dev/tty
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
