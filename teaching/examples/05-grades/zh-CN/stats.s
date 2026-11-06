# 成绩统计：把文字里的数读进数组，再算总分、最低分和最高分。

.data
.globl total
.globl lowest
.globl highest
total:   .word 0
lowest:  .word 0
highest: .word 0

.text
.globl readScores
# readScores：$a0 = 文字，$a1 = 存成绩的数组，$a2 = 数组能放几个
# 返回 $v0 = 读到几个成绩
readScores:
    addiu $sp, $sp, -16    # 保存 $ra 和要用的 $s 寄存器（被调用者保存）
    sw   $ra, 12($sp)
    sw   $s0, 8($sp)
    sw   $s1, 4($sp)
    sw   $s2, 0($sp)
    move $s0, $a1          # $s0 = 下一个成绩放在哪里
    move $s1, $zero        # $s1 = 已读几个
    move $s2, $a2          # $s2 = 最多几个
read_loop:
    beq  $s1, $s2, read_done   # 数组满了
    nop
    jal  nextInt           # 在 text.s：$a0 = 从哪里读
    nop
    beqz $v1, read_done    # 没有数了
    nop
    sw   $v0, 0($s0)
    addiu $s0, $s0, 4      # 每个成绩占 4 字节
    addiu $s1, $s1, 1
    move $a0, $v1          # 接着上一个数后面读
    j    read_loop
    nop
read_done:
    move $v0, $s1
    lw   $s2, 0($sp)       # 恢复保存的寄存器
    lw   $s1, 4($sp)
    lw   $s0, 8($sp)
    lw   $ra, 12($sp)
    addiu $sp, $sp, 16
    jr   $ra
    nop

.globl summarize
# summarize：$a0 = 成绩数组，$a1 = 个数（至少 1）；结果写进 total、lowest、highest
summarize:
    lw   $t0, 0($a0)       # 从第一个成绩开始
    move $t1, $t0          # $t1 = 总分
    move $t2, $t0          # $t2 = 最低分
    move $t3, $t0          # $t3 = 最高分
    li   $t4, 1            # $t4 = i
sum_loop:
    beq  $t4, $a1, sum_done
    nop
    sll  $t5, $t4, 2       # 第 i 个成绩在 i × 4 字节处
    addu $t5, $a0, $t5
    lw   $t6, 0($t5)
    addu $t1, $t1, $t6
    bge  $t6, $t2, not_lower
    nop
    move $t2, $t6          # 更低
not_lower:
    ble  $t6, $t3, not_higher
    nop
    move $t3, $t6          # 更高
not_higher:
    addiu $t4, $t4, 1
    j    sum_loop
    nop
sum_done:
    sw   $t1, total
    sw   $t2, lowest
    sw   $t3, highest
    jr   $ra
    nop
