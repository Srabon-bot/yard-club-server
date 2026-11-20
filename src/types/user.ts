export type RequestUser = {
  id: string;
  role: 'customer' | 'owner' | 'admin';
  name: string;
  email: string;
  slug: string;
};
