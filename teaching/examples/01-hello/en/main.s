# Example 1 · Hello, MIPS
# The program prints one line in the terminal, then ends.
# Try it: click Assemble, then Run; or go line by line with Step Into.
# Change it: replace the text below with your own.

.data
greeting: .asciiz "Hello, MIPS!\n"   # the text to print; \n is a newline, and .asciiz adds a \0 at the end

.text
.globl main
main:
    la   $a0, greeting     # $a0 = the address of the text's first byte (not the text itself)
    li   $v0, 4            # $v0 = 4: syscall prints a string
    syscall
    li   $v0, 10           # $v0 = 10: syscall ends the program
    syscall
