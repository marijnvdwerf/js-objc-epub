var cheerio = require('cheerio');
var url = require('url');

var Parser = {};

Parser.parseIssueOverview = function(baseUri, body) {
    var $ = cheerio.load(body);

    return $('.c-issue-unit')
        .map(function(i, el) {
            var $issue = $(el);
            return {
                id: parseInt($issue.attr('id')),
                uri: url.resolve(baseUri, $issue.find('a').first().attr('href'))
            };
        })
        .get();
};

module.exports = Parser;
