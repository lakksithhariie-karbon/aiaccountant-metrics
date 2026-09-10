import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium transition-colors outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)] disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        default: "bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[color-mix(in_oklch,var(--primary)_88%,black)]",
        outline: "border border-[var(--input)] bg-transparent text-[var(--foreground)] hover:bg-[var(--secondary)]",
        ghost: "bg-transparent text-[var(--foreground)] hover:bg-[var(--secondary)]",
        topbar: "border border-[color-mix(in_oklch,var(--primary-foreground)_45%,transparent)] bg-transparent text-[var(--primary-foreground)] hover:bg-[color-mix(in_oklch,var(--primary-foreground)_12%,transparent)]",
        topbarPlain: "border-0 bg-transparent text-[var(--primary-foreground)] hover:bg-[color-mix(in_oklch,var(--primary-foreground)_12%,transparent)]",
        topbarActive: "border border-[var(--primary-foreground)] bg-[var(--primary-foreground)] text-[var(--primary)]",
        link: "h-auto justify-start bg-transparent p-0 text-[var(--primary)] underline-offset-4 hover:underline",
        chartTable: "h-auto bg-transparent p-0 text-[var(--foreground)] underline-offset-2 hover:text-[var(--primary)] hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        icon: "size-8",
        topbar: "h-8 px-3 text-xs",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);

Button.displayName = "Button";

export { Button, buttonVariants };
