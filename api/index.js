export default function handler(req, res) {
  // Redirect to admin
  res.redirect(302, '/api/admin');
}
