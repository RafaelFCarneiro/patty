interface Props { message: string; action?: React.ReactNode; }

export const EmptyState = ({ message, action }: Props) => (
  <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
    <p className="text-muted">{message}</p>
    {action}
  </div>
);
