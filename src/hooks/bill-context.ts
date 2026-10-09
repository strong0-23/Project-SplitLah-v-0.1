import { createContext } from "react";
import type { BillCtx } from "./use-bill";

/** Kept in its own module so hot reloads of the provider never create a second context. */
export const BillContext = createContext<BillCtx | null>(null);
