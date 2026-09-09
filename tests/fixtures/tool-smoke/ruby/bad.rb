# frozen_string_literal: true

# Tool-smoke fixture for #209/#2780 — ruby-lsp flags the unterminated string.
def greet
  x = 'unterminated
  puts 'hello'
end
