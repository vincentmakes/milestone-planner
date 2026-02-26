"""
Custom exception hierarchy for consistent error responses.

Usage:
    from app.exceptions import NotFoundError, ForbiddenError, ConflictError

    raise NotFoundError("User", user_id)
    raise ForbiddenError("Admin access required")
    raise ConflictError("A user with this email already exists")
    raise ValidationError("Invalid slug format")

These exceptions are caught by the handler registered in main.py and
converted to consistent JSON error responses with the shape:
    {"error": "<message>", "detail": "<optional extra info>"}
"""

from fastapi import HTTPException, status


class AppError(HTTPException):
    """Base application error with a default status code."""

    status_code: int = status.HTTP_500_INTERNAL_SERVER_ERROR

    def __init__(self, message: str, detail: str | None = None):
        super().__init__(
            status_code=self.__class__.status_code,
            detail=message,
        )
        self.extra_detail = detail


class NotFoundError(AppError):
    """Resource not found (404)."""

    status_code = status.HTTP_404_NOT_FOUND

    def __init__(self, resource: str, resource_id: int | str | None = None):
        if resource_id is not None:
            message = f"{resource} not found (id={resource_id})"
        else:
            message = f"{resource} not found"
        super().__init__(message)


class ForbiddenError(AppError):
    """Forbidden access (403)."""

    status_code = status.HTTP_403_FORBIDDEN

    def __init__(self, message: str = "Access denied"):
        super().__init__(message)


class UnauthorizedError(AppError):
    """Unauthorized access (401)."""

    status_code = status.HTTP_401_UNAUTHORIZED

    def __init__(self, message: str = "Authentication required"):
        super().__init__(message)


class ConflictError(AppError):
    """Resource conflict (409)."""

    status_code = status.HTTP_409_CONFLICT

    def __init__(self, message: str):
        super().__init__(message)


class ValidationError(AppError):
    """Validation error (400)."""

    status_code = status.HTTP_400_BAD_REQUEST

    def __init__(self, message: str):
        super().__init__(message)


class ServiceError(AppError):
    """Internal service error (500)."""

    status_code = status.HTTP_500_INTERNAL_SERVER_ERROR

    def __init__(self, message: str = "Internal server error"):
        super().__init__(message)
