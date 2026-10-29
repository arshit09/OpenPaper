// OpenPaper.exe calls showError() when the server can't start; "Try again" reloads this page, which starts it again.
window.showError = (message) => {
  document.body.classList.add('failed');
  document.querySelector('.message').textContent = message;
  document.querySelector('.error').hidden = false;
};
document.getElementById('retry').addEventListener('click', () => location.reload());
