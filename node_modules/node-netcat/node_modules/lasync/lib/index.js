
function runTasks (fn, cb) {
  fn(function cb_fn (err, res) {
    cb(err, res);
  });
}

function runTasksWithArgs (fn, args, cb) {
  args.push(cb);
  fn.apply(null, args);
}

module.exports.series = series;

function series (tasks, done) {
  if (!Array.isArray(tasks))
    throw new Error('Uncaught Error: first parameter must be a Array with the tasks to run!');

  if (!done) done = function () {};

  var results = [];

  // run tasks
  function run (task) {
    if (task) {
      runTasks(task, function cb_async (err, result) {
        // in case error finish flow
        if (err) return done(err);
        // keep result
        results.push(result);
        // iterate again
        return run(tasks.shift());
      });
      return 1;
    }

    // return results
    return done(null, results);
  }

  run(tasks.shift());
}


module.exports.parallel = parallel;

function parallel (tasks, done) {
  if (!Array.isArray(tasks))
    throw new Error('Uncaught Error: first parameter must be a Array with the tasks to run!');

  if (!done) done = function () {};

  var results = [];

  tasks.forEach(function (task) {
    runTasks(task, function (err, result) {
      // in case error finish flow
      if (err) return done(err);
      // keep result
      results.push(result);
      // creturn when reaches the end
      if (tasks.length === results.length) return done(null, results);
    });
  });
}


module.exports.waterfall = waterfall;

function waterfall (tasks, done) {
  if (!Array.isArray(tasks))
    throw new Error('Uncaught Error: first parameter must be a Array with the tasks to run!');

  if (!done) done = function () {};

  function run (task, args) {
    if (task) {
      runTasksWithArgs(task, args, function cb_tasks () {
        var args = Array.prototype.slice.call(arguments);
        if (args[0]) return done(args[0]);
        return run(tasks.shift(), args.slice(1));
      });
      return 1;
    }
    // return result
    return done(null, args.join(''));
  }

  run(tasks.shift(), []);
}