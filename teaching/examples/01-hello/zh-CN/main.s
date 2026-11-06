# 示例 1 · 你好，MIPS
# 程序在终端打印一行字，然后结束。
# 试试：点“汇编”，再点“完整运行”；或者用“源码单步”一行一行看。
# 改一改：把下面的文字换成你自己的。

.data
greeting: .asciiz "Hello, MIPS!\n"   # 要打印的文字；\n 是换行，.asciiz 会在末尾补一个 \0

.text
.globl main
main:
    la   $a0, greeting     # $a0 = 文字第一个字节的地址（不是文字本身）
    li   $v0, 4            # $v0 = 4：syscall 会打印字符串
    syscall
    li   $v0, 10           # $v0 = 10：syscall 会结束程序
    syscall
