// Auth gate — hides page until session is confirmed, redirects to login if not
document.documentElement.style.visibility = 'hidden'
fetch('/api/auth/me')
  .then(function (r) {
    if (r.status === 401) {
      window.location.replace('/login.html')
      return
    }
    if (!r.ok) {
      // 5xx or other error — show retry, don't reveal page
      throw new Error('Server error: ' + r.status)
    }
    return r.json()
  })
  .then(function (user) {
    if (!user) return
    window.__aeo_user = user
    document.documentElement.style.visibility = ''
  })
  .catch(function (err) {
    // Network error or 5xx — show error state, don't reveal page content
    document.body.innerHTML =
      '<div style="text-align:center;margin-top:40vh;font-family:monospace;color:#9f9a9a">' +
      '<p>Connection error</p>' +
      '<a href="/" style="color:rgb(238,82,24)">Retry</a></div>'
    document.documentElement.style.visibility = ''
  })
