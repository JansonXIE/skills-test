#!/bin/bash
# resolve_conflicts.sh
# 用法: bash resolve_conflicts.sh <冲突文件路径> <cherry-pick的commit引用>
# 策略: 保留 HEAD (当前) 代码，将 cherry-pick 中的【纯新增行】追加进来

FILE="$1"
FETCH_REF="${2:-FETCH_HEAD}"

if [ -z "$FILE" ]; then
    echo "用法: $0 <冲突文件> [FETCH_HEAD]"
    exit 1
fi

if [ ! -f "$FILE" ]; then
    echo "❌ 文件不存在: $FILE"
    exit 1
fi

# 检查文件是否包含冲突标记
if ! grep -q "^<<<<<<< " "$FILE"; then
    echo "✅ 文件无冲突标记，跳过: $FILE"
    exit 0
fi

TMPFILE=$(mktemp)
IN_OURS=0      # 在 <<<< HEAD 区域内
IN_THEIRS=0    # 在 ==== 到 >>>> 区域内
OURS_LINES=()  # 当前分支的行（用于去重对比）

# 第一遍: 收集 HEAD 区域所有内容（用于判断哪些是真正新增）
mapfile -t OURS_LINES < <(
    awk '
        /^<<<<<<< / { in_ours=1; next }
        /^=======$/ { if(in_ours) { in_ours=0; in_theirs=1 } next }
        /^>>>>>>> / { in_theirs=0; next }
        in_ours { print }
    ' "$FILE"
)

# 构建 ours 内容的 set（用于快速查找）
declare -A OURS_SET
for line in "${OURS_LINES[@]}"; do
    OURS_SET["$line"]=1
done

# 第二遍: 生成解决后的文件
while IFS= read -r line; do
    if [[ "$line" =~ ^"<<<<<<< " ]]; then
        IN_OURS=1
        IN_THEIRS=0
        continue
    elif [[ "$line" == "=======" ]]; then
        if [ $IN_OURS -eq 1 ]; then
            IN_OURS=0
            IN_THEIRS=1
        fi
        continue
    elif [[ "$line" =~ ^">>>>>>> " ]]; then
        IN_THEIRS=0
        continue
    fi

    if [ $IN_OURS -eq 1 ]; then
        # 输出当前分支代码（完整保留）
        echo "$line" >> "$TMPFILE"
    elif [ $IN_THEIRS -eq 1 ]; then
        # 仅输出 cherry-pick 中当前分支没有的行（纯新增）
        trimmed="${line#"${line%%[![:space:]]*}"}"  # trim leading spaces for comparison
        if [ -z "${OURS_SET[$line]+x}" ] && [ -z "${OURS_SET[$trimmed]+x}" ]; then
            echo "$line" >> "$TMPFILE"
        fi
    else
        # 正常代码（无冲突区域）直接输出
        echo "$line" >> "$TMPFILE"
    fi
done < "$FILE"

# 用解决后的内容替换原文件
mv "$TMPFILE" "$FILE"
echo "✅ 冲突已解决（补充策略）: $FILE"
