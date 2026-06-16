# Alternate-primary fixture: the Jedi LSP (jedi-language-server) is the fallback
# for the Python file kind when the default `python` server (pyright) is
# disabled. The missing colon after the def is a syntax error that
# jedi-language-server publishes as a diagnostic on didOpen.
def greet(name)
    print(name)
