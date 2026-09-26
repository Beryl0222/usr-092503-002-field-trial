/** 领域错误，携带 HTTP 状态码，便于 API 层统一映射。 */
export class DomainError extends Error {
  constructor(message, { code = "domain_error", status = 400 } = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = status;
  }
}

export class ValidationError extends DomainError {
  constructor(message) {
    super(message, { code: "validation_error", status: 400 });
    this.name = "ValidationError";
  }
}

export class NotFoundError extends DomainError {
  constructor(message) {
    super(message, { code: "not_found", status: 404 });
    this.name = "NotFoundError";
  }
}

export class ConflictError extends DomainError {
  constructor(message) {
    super(message, { code: "conflict", status: 409 });
    this.name = "ConflictError";
  }
}

/** 安全冻结生效期间，普通操作被抢占。 */
export class FrozenError extends DomainError {
  constructor(message) {
    super(message, { code: "frozen", status: 423 });
    this.name = "FrozenError";
  }
}

export class AuthorizationError extends DomainError {
  constructor(message) {
    super(message, { code: "forbidden", status: 403 });
    this.name = "AuthorizationError";
  }
}

/** 事件日志哈希链校验失败。 */
export class IntegrityError extends DomainError {
  constructor(message) {
    super(message, { code: "integrity_error", status: 500 });
    this.name = "IntegrityError";
  }
}
