import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center border px-2 py-0.5 text-[11px] font-medium tabular-nums",
  {
    variants: {
      variant: {
        default: "border-[var(--border)] bg-transparent text-[var(--muted-foreground)]",
        subtle: "border-[var(--border)] bg-[var(--secondary)] text-[var(--secondary-foreground)]",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
