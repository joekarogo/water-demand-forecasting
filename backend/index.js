const { app } = require('./app');

const PORT = process.env.PORT || 5000;

app.listen(PORT, (err) => {
  if (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use.`);
    } else {
      console.error(err);
    }
    process.exit(1);
  }
  console.log(`Server running on port ${PORT}`);
});
