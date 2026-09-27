import { logger } from "../../lib/logger.js";
import type { RealPathWithinBaseError } from "../../lib/real-path.js";

export type ErrorResponse = {
  readonly status: 403 | 404 | 500;
  readonly message: string;
};

/** Maps a failed path lookup to the HTTP response every route returns for it. */
export function realPathErrorResponse(
  error: RealPathWithinBaseError,
): ErrorResponse {
  switch (error.type) {
    case "outside-base":
      return { status: 403, message: "Forbidden" };
    case "not-found":
      return { status: 404, message: "File not found" };
    case "io-error":
      logger.error("Failed to read file:", error.cause);
      return { status: 500, message: "Failed to read file" };
  }
}
