#!/usr/bin/env bash

# Configuration: Sensitive patterns to look for
SENSITIVE_PATTERNS=("API_KEY" "PASSWORD" "SECRET" "TOKEN" "AUTH")
SOURCE_DIR=$(chezmoi source-path)
# Extract age public key for SOPS
AGE_KEY=$(grep "public key:" ~/.config/chezmoi/key.txt | cut -d: -f2 | xargs)

# --- LOOP PREVENTION ---
# Debug logging (optional: uncomment for troubleshooting)
# LOG_FILE="$HOME/.chezmoi_check_secrets.log"
# echo "--- $(date) ---" >> "$LOG_FILE"
# echo "Args: $@" >> "$LOG_FILE"
# echo "CHEZMOI_ARGS: $CHEZMOI_ARGS" >> "$LOG_FILE"

# Check if --encrypt or -e is present in the command arguments or CHEZMOI_ARGS
# Also add an exception for .tmpl and .sops.yaml files to avoid re-triggering the hook
IS_BYPASS=false
for arg in "$@" $CHEZMOI_ARGS; do
    if [[ "$arg" == "--encrypt" ]] || [[ "$arg" == "-e" ]] || [[ "$arg" == *.tmpl ]] || [[ "$arg" == *.sops.yaml ]]; then
        IS_BYPASS=true
        break
    fi
done

if [ "$IS_BYPASS" = true ]; then
    # echo "Bypassing hook (detected bypass arg or protected extension)" >> "$LOG_FILE"
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
                # Calculate relative path from HOME and transform to chezmoi-style path
                # e.g., /home/user/.config/test.yaml -> dot_config/test.yaml
                ABS_FILE=$(realpath "$file")
                REL_PATH=$(realpath --relative-to="$HOME" "$ABS_FILE")
                
                # Transform path: replace starting dot with dot_, and any /dot with /dot_
                # This mirrors how chezmoi stores files in the source directory
                CHEZMOI_REL_PATH=$(echo "$REL_PATH" | sed -e 's/^\./dot_/' -e 's/\/\./\/dot_/g')
                
                SOPS_FILE_NAME="${CHEZMOI_REL_PATH}.sops.yaml"
                SOPS_SOURCE_PATH="$SOURCE_DIR/secrets/$SOPS_FILE_NAME"
                
                # Ensure the target directory for the secret exists
                mkdir -p "$(dirname "$SOPS_SOURCE_PATH")"
                
                TMP_SECRETS_FILE=$(mktemp)
                
                # Create the template file
                TMP_TEMPLATE_FILE=$(mktemp --suffix=.tmpl_tmp)
                # Add a harmless template comment to force chezmoi to recognize it as a template
                echo '{{- /* chezmoi:template */ -}}' > "$TMP_TEMPLATE_FILE"
                cat "$file" >> "$TMP_TEMPLATE_FILE"
                
                echo "Identifying and extracting secrets..." > /dev/tty
                
                # Simplified extraction for KEY=VALUE or KEY: VALUE patterns
                declare -A EXTRACTED_KEYS
                for pattern in "${SENSITIVE_PATTERNS[@]}"; do
                    # Find all lines matching the pattern and extract keys/values
                    while read -r line; do
                        # Extract key and value using basic delimiters
                        key_raw=$(echo "$line" | cut -d'=' -f1 | cut -d':' -f1 | xargs)
                    # Strip quotes from key
                    key=$(echo "$key_raw" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")

                    value_raw=$(echo "$line" | cut -d'=' -f2- | cut -d':' -f2- | xargs)
                    # Strip trailing comma, then strip quotes
                    value=$(echo "$value_raw" | sed -e 's/,$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")

                    if [ -n "$key" ] && [ -n "$value" ] && [ -z "${EXTRACTED_KEYS[$key]}" ]; then
                        # Store in temporary yaml for sops
                        echo "${key}: ${value}" >> "$TMP_SECRETS_FILE"
                        EXTRACTED_KEYS[$key]=1

                        # Update the template file with the reference
                        template_ref="{{ (index ((secret \"-d\" (joinPath .chezmoi.sourceDir \"secrets/$SOPS_FILE_NAME\") | fromYaml).data | fromYaml) \"${key}\") }}"
                        
                        # Replace only on lines that look like KEY: VALUE or KEY = VALUE
                        # Escaping dots in key for regex
                        esc_key=$(echo "$key" | sed 's/\./\\./g')
                        sed -i "/^[[:space:]]*[\"']\?${esc_key}[\"']\?[[:space:]]*[:=]/ s@${value}@${template_ref}@" "$TMP_TEMPLATE_FILE"
                    fi
                    done < <(grep -Ei "$pattern" "$file")
                done
                
                # Encrypt the secrets file to the source directory
                echo "Creating sops-encrypted file at $SOPS_SOURCE_PATH..." > /dev/tty
                sops --encrypt --age "$AGE_KEY" "$TMP_SECRETS_FILE" > "$SOPS_SOURCE_PATH"
                
                # Add the template to chezmoi
                FINAL_TMPL_NAME="${file}.tmpl"
                echo "Adding template $FINAL_TMPL_NAME to chezmoi..." > /dev/tty
                cp "$TMP_TEMPLATE_FILE" "$FINAL_TMPL_NAME"
                chezmoi add "$FINAL_TMPL_NAME"
                
                # If chezmoi added it with .literal suffix, rename it in source
                SOURCE_FILE=$(chezmoi source-path "$FINAL_TMPL_NAME")
                if [[ "$SOURCE_FILE" == *.literal ]]; then
                    NEW_SOURCE_FILE="${SOURCE_FILE%.literal}"
                    mv "$SOURCE_FILE" "$NEW_SOURCE_FILE"
                fi
                
                # Cleanup: Delete the original file and the temporary template
                echo "Cleaning up..." > /dev/tty
                rm "$file" "$FINAL_TMPL_NAME" "$TMP_TEMPLATE_FILE" "$TMP_SECRETS_FILE"
                
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
