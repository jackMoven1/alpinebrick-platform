export class AdminApiError extends Error {
  constructor(message, code = 'INTERNAL', fields = undefined) {
    super(message)
    this.name = 'AdminApiError'
    this.code = code
    if (fields) this.fields = fields
  }
}
