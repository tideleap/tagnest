import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { Button, EmptyState } from '@/components/ui';

export function NotFoundPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <EmptyState
        icon={<Compass size={22} />}
        title="这个页面不存在"
        description="链接可能已经失效，或者地址输错了。"
        action={
          <Link to="/library/inbox">
            <Button variant="primary">回到收件箱</Button>
          </Link>
        }
      />
    </div>
  );
}
