export function validateInput(input = {}) {
  const name = String(input.name ?? '').trim();
  const email = String(input.email ?? '').trim();
  const description = String(input.description ?? '').trim();
  const errors = {};
  if (name.length < 2) errors.name = 'Enter the employee name (at least 2 characters).';
  if (name.length > 100) errors.name = 'Name is too long (max 100).';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email = 'Enter a valid email address.';
  if (description.length < 5) errors.description = 'Describe the request (at least 5 characters).';
  if (description.length > 2000) errors.description = 'Request is too long (max 2000 characters).';
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, clean: { name, email, description } };
}
