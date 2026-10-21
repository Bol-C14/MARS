# MARS Trace — modern teaching IDE

This fork adds a local CodeMirror-based teaching and debugging workspace backed by the original MARS execution core.

**[Start here: setup, controls and supported scope](teaching/README.md)** · [Design](teaching/docs/DESIGN.md) · [Architecture](teaching/docs/ARCHITECTURE.md) · [Validation](teaching/docs/VALIDATION.md)

```sh
sh teaching/scripts/start.sh
```

Open http://127.0.0.1:8765. Requires JDK 17+. The frontend is bundled for offline use.

M0–M2 includes source/expanded-instruction/CFG views, actual and preview data-flow overlays, reversible virtual I/O, conditional breakpoints, read/write watches, call stepping, loop history and last-writer lookup.

---

## Original upstream project

# MARS
MARS (official) MIPS Assembler and Runtime Simulator

 MARS is a lightweight interactive development environment (IDE) for programming in MIPS assembly language, intended for educational-level use with Patterson and Hennessy's Computer Organization and Design.

 It is available for you to download as an executable JAR file.  Click the MARS v.4.5 link at right, under Releases, to access the download.

 We have relocated the MARS website to  https://dpetersanderson.github.io/    There are still a couple of display issues to work out but all website content is there.  This includes all documentation and the JAR download.  We are not experienced in github so if you know a way we can host the website in this MARS repository let us know.

 This is the original MARS, developed by Pete Sanderson and Ken Vollmar.  Developed while Pete was professor at Otterbein University and Ken was professor at Missouri State University.  Both are now retired. This is a legacy application but is very stable and continues to be used by universities throughout the world as of 2024. The last release was MARS 4.5 in August 2014.  
 
 Until October 2024 the MARS website, including executable JAR file download, was hosted by Missouri State University. That is no longer the case. That's why it is here.
