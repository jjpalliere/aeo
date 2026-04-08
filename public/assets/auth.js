// Auth gate — hides page until cookie is confirmed, redirects to login if not
document.documentElement.style.visibility = 'hidden'
fetch('api/health').then(function (r) {
  if (r.status === 401) { window.location.replace('login.html'); return }
  document.documentElement.style.visibility = ''
}).catch(function () {
  document.documentElement.style.visibility = ''
})
