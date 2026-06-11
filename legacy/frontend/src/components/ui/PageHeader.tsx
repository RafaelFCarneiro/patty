interface Props { title: string; children?: React.ReactNode; }

export const PageHeader = ({ title, children }: Props) => (
  <div className="flex items-center justify-between p-6 pb-4">
    <h1 className="text-2xl font-bold text-white">{title}</h1>
    <div className="flex items-center gap-2">{children}</div>
  </div>
);
