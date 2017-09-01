$(document).ready(function(){
  impress().init();
  var slides = [];
  $("#impress div").children("h1").each(function(h1){
    var onepage = this.nextUntil("h1");
    var div = $("#impress").add("div");
    div.add(this);
    div.add(onepage);
  });
});