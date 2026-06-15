# Tool-smoke fixture for #209 — tflint flags the deprecated interpolation-only
# expression (terraform_deprecated_interpolation).
variable "name" {
  type = string
}

output "greeting" {
  value = "${var.name}"
}
