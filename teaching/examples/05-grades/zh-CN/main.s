# 示例 5 · 完整项目：成绩统计
# 读出 input.txt 里的成绩（每行一个），算出个数、总分、最低分、最高分和平均分，
# 在终端打印，并写进 report.txt。
# 文件：main.s 主流程 · fileio.s 读写文件 · text.s 文字与数字转换 · stats.s 统计
# 试试：改 input.txt 里的成绩再运行；用“跨过调用”跳过已经看懂的函数，用“跳出函数”回到调用处。

.data
inputName:  .asciiz "input.txt"
outputName: .asciiz "report.txt"
buffer:     .space 4096    # 整个 input.txt 读到这里
.align 2                   # 下一项从 4 的倍数地址开始：lw/sw 要求字对齐
scores:     .space 400     # 最多 100 个成绩，每个 4 字节
report:     .space 256     # 报告的文字先在这里拼好
openError:  .asciiz "Cannot open input.txt\n"
noScores:   .asciiz "No scores found\n"
countT:     .asciiz "Scores:  "
totalT:     .asciiz "\nTotal:   "
lowestT:    .asciiz "\nLowest:  "
highestT:   .asciiz "\nHighest: "
averageT:   .asciiz "\nAverage: "
newline:    .asciiz "\n"

.text
.globl main
main:
    la   $a0, inputName
    la   $a1, buffer
    li   $a2, 4096
    jal  loadFile          # 在 fileio.s：$v0 = 读到的字节数，打不开时为负数
    nop
    bltz $v0, open_failed
    nop

    la   $a0, buffer
    la   $a1, scores
    li   $a2, 100
    jal  readScores        # 在 stats.s：$v0 = 读到几个成绩
    nop
    move $s0, $v0          # $s0 = 成绩个数
    beqz $s0, no_scores
    nop

    la   $a0, scores
    move $a1, $s0
    jal  summarize         # 在 stats.s：算出 total、lowest、highest
    nop

# 把报告拼进 report：每次 append 返回下一段要写的位置
    la   $a0, report
    la   $a1, countT
    jal  appendText
    nop
    move $a0, $v0
    move $a1, $s0
    jal  appendInt
    nop
    move $a0, $v0
    la   $a1, totalT
    jal  appendText
    nop
    move $a0, $v0
    lw   $a1, total        # total 定义在 stats.s，用 .globl 共享
    jal  appendInt
    nop
    move $a0, $v0
    la   $a1, lowestT
    jal  appendText
    nop
    move $a0, $v0
    lw   $a1, lowest
    jal  appendInt
    nop
    move $a0, $v0
    la   $a1, highestT
    jal  appendText
    nop
    move $a0, $v0
    lw   $a1, highest
    jal  appendInt
    nop
    move $a0, $v0
    la   $a1, averageT
    jal  appendText
    nop
    lw   $t0, total
    divu $t0, $s0          # 平均分 = 总分 ÷ 个数（向下取整）
    mflo $a1
    move $a0, $v0
    jal  appendInt
    nop
    move $a0, $v0
    la   $a1, newline
    jal  appendText
    nop
    move $s1, $v0          # $s1 = 报告结尾的位置

    li   $v0, 4            # 在终端打印报告
    la   $a0, report
    syscall

    la   $a0, outputName   # 再把同样的文字写进 report.txt
    la   $a1, report
    la   $t0, report
    subu $a2, $s1, $t0     # 长度 = 结尾 − 开头
    jal  saveFile
    nop
    li   $v0, 10
    syscall

no_scores:
    li   $v0, 4
    la   $a0, noScores
    syscall
    li   $v0, 10
    syscall

open_failed:
    li   $v0, 4
    la   $a0, openError
    syscall
    li   $a0, 1            # 退出码 1 表示出错
    li   $v0, 17           # $v0 = 17：带退出码结束
    syscall
