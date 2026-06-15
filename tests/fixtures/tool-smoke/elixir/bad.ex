# Tool-smoke fixture for #209 — elixirc flags the undefined function call.
defmodule Smoke do
  def greet do
    undefined_function()
  end
end
